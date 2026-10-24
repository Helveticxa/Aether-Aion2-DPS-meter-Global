//! Where Aether's panels open: the detail, history and settings windows that
//! belong to the DPS overlay.
//!
//! They used to go at a fixed offset from the overlay -- the detail window
//! 8 px to its right, history 8 px below -- whatever the screen. With the
//! overlay near the right edge, or on a smaller or scaled display (a
//! 1080 x 960 detail window fits neither a 1366 x 768 laptop nor 1080p at
//! 125%), the panel opened partly or wholly off screen and looked as if it had
//! not opened at all. Now a panel goes beside its anchor where there is room,
//! on the other side where there is not, is shrunk to the work area when it is
//! larger, and always lands on the anchor's monitor.

use tauri::{Monitor, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

/// Which side of its anchor a panel prefers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Right,
    Below,
}

/// A rectangle in physical pixels, in the virtual-screen coordinates Windows
/// gives a per-monitor DPI aware process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x + self.width
    }

    fn bottom(&self) -> i32 {
        self.y + self.height
    }

    fn union(self, other: Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Rect {
            x,
            y,
            width: self.right().max(other.right()) - x,
            height: self.bottom().max(other.bottom()) - y,
        }
    }
}

/// Where a panel of `size` goes beside `anchor`, inside `area`.
pub fn place(anchor: Rect, size: (i32, i32), area: Rect, side: Side, gap: i32) -> Rect {
    let width = size.0.clamp(1, area.width.max(1));
    let height = size.1.clamp(1, area.height.max(1));
    let (x, y) = match side {
        Side::Right => {
            let x = if anchor.right() + gap + width <= area.right() {
                anchor.right() + gap
            } else if anchor.x - gap - width >= area.x {
                anchor.x - gap - width
            } else {
                // Room on neither side: against whichever edge has more.
                if area.right() - anchor.right() >= anchor.x - area.x {
                    area.right() - width
                } else {
                    area.x
                }
            };
            (x, anchor.y)
        }
        Side::Below => {
            let y = if anchor.bottom() + gap + height <= area.bottom() {
                anchor.bottom() + gap
            } else if anchor.y - gap - height >= area.y {
                anchor.y - gap - height
            } else if area.bottom() - anchor.bottom() >= anchor.y - area.y {
                area.bottom() - height
            } else {
                area.y
            };
            (anchor.x, y)
        }
    };
    Rect {
        x: x.clamp(area.x, area.right() - width),
        y: y.clamp(area.y, area.bottom() - height),
        width,
        height,
    }
}

/// Centred in `area`, shrunk to fit it.
pub fn centre(size: (i32, i32), area: Rect) -> Rect {
    let width = size.0.clamp(1, area.width.max(1));
    let height = size.1.clamp(1, area.height.max(1));
    Rect {
        x: area.x + (area.width - width) / 2,
        y: area.y + (area.height - height) / 2,
        width,
        height,
    }
}

/// A window's outer rectangle, unless it is minimised: Windows parks those at
/// -32000, which is no place to put anything next to.
pub fn window_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<Rect> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    (position.x > -30_000 && position.y > -30_000).then_some(Rect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    })
}

fn work_area(monitor: &Monitor) -> Rect {
    let area = monitor.work_area();
    Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width as i32,
        height: area.size.height as i32,
    }
}

/// The work area of the monitor `window` is on, or the primary one.
fn monitor_area<R: Runtime>(window: &WebviewWindow<R>) -> Option<Rect> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .map(|monitor| work_area(&monitor))
}

/// Put `panel` beside `anchors` (the windows it belongs to, taken together),
/// or centred on their monitor when `centred` or when none is on screen.
pub fn place_panel<R: Runtime>(
    panel: &WebviewWindow<R>,
    anchors: &[WebviewWindow<R>],
    side: Side,
    gap: i32,
    centred: bool,
) -> Result<(), String> {
    let anchor = anchors
        .iter()
        .filter_map(window_rect)
        .reduce(Rect::union);
    let area = anchors
        .first()
        .and_then(monitor_area)
        .or_else(|| monitor_area(panel))
        .ok_or("no monitor to place the window on")?;
    let size = panel.outer_size().map_err(|e| e.to_string())?;
    let size = (size.width as i32, size.height as i32);

    let target = match anchor {
        Some(anchor) if !centred => place(anchor, size, area, side, gap),
        _ => centre(size, area),
    };
    if (target.width, target.height) != size {
        panel
            .set_size(PhysicalSize::new(target.width as u32, target.height as u32))
            .map_err(|e| e.to_string())?;
    }
    panel
        .set_position(PhysicalPosition::new(target.x, target.y))
        .map_err(|e| e.to_string())
}

/// Bring `window` to the top of the always-on-top windows without taking the
/// keyboard. Showing a window that is already up leaves it where it is in the
/// stack, so a panel reopened from a click elsewhere could stay behind that
/// window.
pub fn raise_without_focus<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        unsafe {
            let _ = SetWindowPos(
                windows::Win32::Foundation::HWND(hwnd.0 as _),
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_panel_goes_to_the_right_where_it_fits() {
        let overlay = rect(33, 133, 264, 96);
        assert_eq!(
            place(overlay, (1080, 807), SCREEN, Side::Right, 8),
            rect(305, 133, 1080, 807)
        );
    }

    #[test]
    fn with_the_overlay_on_the_right_edge_the_panel_opens_to_its_left() {
        // The old rule put this detail window at x = 1912: off screen.
        let overlay = rect(1640, 100, 264, 96);
        assert_eq!(
            place(overlay, (1080, 807), SCREEN, Side::Right, 8),
            rect(552, 100, 1080, 807)
        );
    }

    #[test]
    fn a_panel_larger_than_the_screen_is_shrunk_and_kept_on_it() {
        // 1080 x 960 logical at 125% on a 1366 x 728 work area.
        let laptop = rect(0, 0, 1366, 728);
        let overlay = rect(20, 600, 264, 96);
        let placed = place(overlay, (1350, 1200), laptop, Side::Right, 8);
        assert_eq!(placed, rect(16, 0, 1350, 728));
    }

    #[test]
    fn history_opens_above_an_overlay_at_the_bottom_of_the_screen() {
        let overlay = rect(33, 900, 264, 96);
        assert_eq!(
            place(overlay, (320, 600), SCREEN, Side::Below, 8),
            rect(33, 292, 320, 600)
        );
    }

    #[test]
    fn a_second_monitor_to_the_left_keeps_its_own_coordinates() {
        let left = rect(-1920, 0, 1920, 1040);
        let overlay = rect(-300, 50, 264, 96);
        let placed = place(overlay, (1080, 807), left, Side::Right, 8);
        assert!(placed.x >= left.x && placed.x + placed.width <= 0);
    }

    #[test]
    fn anchors_are_taken_together() {
        let overlay = rect(33, 133, 264, 96);
        let history = rect(33, 237, 320, 600);
        assert_eq!(overlay.union(history), rect(33, 133, 320, 704));
    }
}
