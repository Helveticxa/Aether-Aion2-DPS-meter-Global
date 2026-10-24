use std::collections::HashMap;

const MAX_HELD_BYTES: usize = 2 * 1024 * 1024;
/// How long out-of-order data waits, in capture time, for the bytes before it.
///
/// TCP resends a segment the network lost within a second or so. A segment the
/// capture dropped is never resent -- the game received it -- and waiting for
/// the byte limit instead meant waiting for 2 MB on a connection that carries
/// one to three KB a second: the meter froze for the rest of the zone.
const GAP_TIMEOUT_SECS: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TcpFlowKey {
    pub src_ip: [u8; 4],
    pub src_port: u16,
    pub dst_ip: [u8; 4],
    pub dst_port: u16,
}

#[derive(Debug)]
struct PendingSegment {
    sequence: u32,
    data: Vec<u8>,
}

#[derive(Debug, Default)]
pub struct TcpReassembler {
    next_sequence: Option<u32>,
    pending: HashMap<u32, Vec<u8>>,
    held_bytes: usize,
    retransmits: u64,
    gap_skips: u64,
    /// Capture time out-of-order data started waiting for a gap to fill.
    held_since: Option<f64>,
}

impl TcpReassembler {
    /// Take a segment captured at `now` (seconds), and return the stream
    /// bytes that are now in order.
    pub fn feed(&mut self, sequence: u32, data: Vec<u8>, now: f64) -> Vec<Vec<u8>> {
        if data.is_empty() {
            return Vec::new();
        }

        let Some(next_sequence) = self.next_sequence else {
            self.next_sequence = Some(sequence.wrapping_add(data.len() as u32));
            return vec![data];
        };

        let mut emitted = Vec::new();
        match trim_consumed_prefix(sequence, data, next_sequence) {
            None => self.retransmits += 1,
            Some(segment) if segment.sequence == next_sequence => {
                emitted.push(segment.data);
                self.advance_and_drain(&mut emitted);
            }
            Some(segment) => self.insert_pending(segment),
        }
        self.skip_gap_if_stalled(now, &mut emitted);
        emitted
    }

    /// Give up on a gap that has held data back too long, or too much of it,
    /// and carry on from the first data after it.
    fn skip_gap_if_stalled(&mut self, now: f64, emitted: &mut Vec<Vec<u8>>) {
        if self.pending.is_empty() {
            self.held_since = None;
            return;
        }
        let since = *self.held_since.get_or_insert(now);
        if self.held_bytes <= MAX_HELD_BYTES && now - since <= GAP_TIMEOUT_SECS {
            return;
        }
        self.gap_skips += 1;
        let next_sequence = self.next_sequence.unwrap_or_default();
        if let Some(nearest_sequence) = self.nearest_pending_sequence(next_sequence) {
            self.next_sequence = Some(nearest_sequence);
            self.drain_contiguous(emitted);
        }
        self.held_since = (!self.pending.is_empty()).then_some(now);
    }

    pub fn retransmits(&self) -> u64 {
        self.retransmits
    }

    pub fn gap_skips(&self) -> u64 {
        self.gap_skips
    }

    pub fn next_sequence(&self) -> Option<u32> {
        self.next_sequence
    }

    pub fn pending_segments(&self) -> usize {
        self.pending.len()
    }

    pub fn held_bytes(&self) -> usize {
        self.held_bytes
    }

    fn advance_and_drain(&mut self, emitted: &mut Vec<Vec<u8>>) {
        if let Some(last) = emitted.last() {
            let next = self
                .next_sequence
                .unwrap_or_default()
                .wrapping_add(last.len() as u32);
            self.next_sequence = Some(next);
        }
        self.drain_contiguous(emitted);
    }

    fn drain_contiguous(&mut self, emitted: &mut Vec<Vec<u8>>) {
        loop {
            let next = self.next_sequence.unwrap_or_default();
            let Some((sequence, data)) = self.take_segment_covering(next) else {
                break;
            };
            self.held_bytes = self.held_bytes.saturating_sub(data.len());
            let consumed = next.wrapping_sub(sequence) as usize;
            if consumed >= data.len() {
                self.retransmits += 1;
                continue;
            }
            let remaining = if consumed == 0 {
                data
            } else {
                self.retransmits += 1;
                data[consumed..].to_vec()
            };
            self.next_sequence = Some(next.wrapping_add(remaining.len() as u32));
            emitted.push(remaining);
        }
    }

    fn take_segment_covering(&mut self, next_sequence: u32) -> Option<(u32, Vec<u8>)> {
        let fully_consumed: Vec<u32> = self
            .pending
            .iter()
            .filter_map(|(sequence, data)| {
                let relative = sequence.wrapping_sub(next_sequence) as i32;
                let consumed = next_sequence.wrapping_sub(*sequence) as usize;
                (relative < 0 && consumed >= data.len()).then_some(*sequence)
            })
            .collect();
        for sequence in fully_consumed {
            if let Some(data) = self.pending.remove(&sequence) {
                self.held_bytes = self.held_bytes.saturating_sub(data.len());
                self.retransmits += 1;
            }
        }

        let sequence = self
            .pending
            .iter()
            .filter_map(|(sequence, data)| {
                let relative = sequence.wrapping_sub(next_sequence) as i32;
                let distance = next_sequence.wrapping_sub(*sequence) as usize;
                if *sequence == next_sequence || (relative < 0 && distance < data.len()) {
                    Some((*sequence, distance))
                } else {
                    None
                }
            })
            .min_by_key(|(_, distance)| *distance)
            .map(|(sequence, _)| sequence)?;
        self.pending.remove(&sequence).map(|data| (sequence, data))
    }

    fn insert_pending(&mut self, segment: PendingSegment) {
        if let Some(previous) = self.pending.get(&segment.sequence) {
            if previous.len() >= segment.data.len() {
                self.retransmits += 1;
                return;
            }
            self.held_bytes = self.held_bytes.saturating_sub(previous.len());
        }

        self.held_bytes += segment.data.len();
        self.pending.insert(segment.sequence, segment.data);
    }

    fn nearest_pending_sequence(&self, next_sequence: u32) -> Option<u32> {
        self.pending
            .keys()
            .copied()
            .min_by_key(|sequence| sequence.wrapping_sub(next_sequence))
    }
}

fn trim_consumed_prefix(
    sequence: u32,
    data: Vec<u8>,
    next_sequence: u32,
) -> Option<PendingSegment> {
    let distance = sequence.wrapping_sub(next_sequence) as i32;
    if distance >= 0 {
        return Some(PendingSegment { sequence, data });
    }

    let consumed = next_sequence.wrapping_sub(sequence) as usize;
    if consumed >= data.len() {
        return None;
    }

    Some(PendingSegment {
        sequence: next_sequence,
        data: data[consumed..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::TcpReassembler;

    #[test]
    fn holds_out_of_order_data_until_gap_arrives() {
        let mut reassembler = TcpReassembler::default();
        assert_eq!(reassembler.feed(100, vec![1, 2], 0.0), vec![vec![1, 2]]);
        assert!(reassembler.feed(104, vec![5, 6], 0.0).is_empty());
        assert_eq!(
            reassembler.feed(102, vec![3, 4], 0.0),
            vec![vec![3, 4], vec![5, 6]]
        );
    }

    #[test]
    fn drops_retransmits_and_trims_partial_overlap() {
        let mut reassembler = TcpReassembler::default();
        assert_eq!(
            reassembler.feed(100, vec![1, 2, 3, 4], 0.0),
            vec![vec![1, 2, 3, 4]]
        );
        assert!(reassembler.feed(100, vec![1, 2, 3, 4], 0.0).is_empty());
        assert_eq!(reassembler.feed(102, vec![3, 4, 5, 6], 0.0), vec![vec![5, 6]]);
    }

    #[test]
    fn handles_sequence_wrap() {
        let mut reassembler = TcpReassembler::default();
        assert_eq!(reassembler.feed(u32::MAX - 1, vec![1, 2], 0.0), vec![vec![1, 2]]);
        assert_eq!(reassembler.feed(0, vec![3, 4], 0.0), vec![vec![3, 4]]);
    }

    #[test]
    fn trims_overlap_from_a_previously_held_segment() {
        let mut reassembler = TcpReassembler::default();
        assert_eq!(reassembler.feed(100, vec![1, 2], 0.0), vec![vec![1, 2]]);
        assert!(reassembler.feed(104, vec![5, 6, 7, 8], 0.0).is_empty());
        assert_eq!(
            reassembler.feed(102, vec![3, 4, 5, 6], 0.0),
            vec![vec![3, 4, 5, 6], vec![7, 8]]
        );
    }

    #[test]
    fn a_gap_the_capture_dropped_is_skipped_after_a_while() {
        let mut reassembler = TcpReassembler::default();
        assert_eq!(reassembler.feed(100, vec![1, 2], 10.0), vec![vec![1, 2]]);
        // 102..104 never arrives: the game got it, the capture did not.
        assert!(reassembler.feed(104, vec![5, 6], 10.1).is_empty());
        assert!(reassembler.feed(106, vec![7, 8], 11.0).is_empty());
        assert_eq!(
            reassembler.feed(108, vec![9], 12.2),
            vec![vec![5, 6], vec![7, 8], vec![9]]
        );
        assert_eq!(reassembler.gap_skips(), 1);
        // And the stream carries on in order afterwards.
        assert_eq!(reassembler.feed(109, vec![10], 12.3), vec![vec![10]]);
    }

    #[test]
    fn a_resent_segment_inside_the_wait_fills_the_gap() {
        let mut reassembler = TcpReassembler::default();
        assert_eq!(reassembler.feed(100, vec![1, 2], 10.0), vec![vec![1, 2]]);
        assert!(reassembler.feed(104, vec![5, 6], 10.1).is_empty());
        assert_eq!(
            reassembler.feed(102, vec![3, 4], 10.4),
            vec![vec![3, 4], vec![5, 6]]
        );
        assert_eq!(reassembler.gap_skips(), 0);
    }

    #[test]
    fn removes_a_held_segment_fully_covered_by_later_data() {
        let mut reassembler = TcpReassembler::default();
        assert_eq!(reassembler.feed(100, vec![1, 2], 0.0), vec![vec![1, 2]]);
        assert!(reassembler.feed(106, vec![7, 8], 0.0).is_empty());
        assert!(reassembler.feed(104, vec![5, 6], 0.0).is_empty());
        assert_eq!(
            reassembler.feed(102, vec![3, 4, 5, 6, 7, 8], 0.0),
            vec![vec![3, 4, 5, 6, 7, 8]]
        );
        assert!(reassembler
            .feed(108, vec![9], 0.0)
            .iter()
            .any(|part| part == &[9]));
    }
}
