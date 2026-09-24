//! Which program a process id belongs to, without touching that program.
//!
//! Opening a handle to another process -- even with the harmless-sounding
//! `PROCESS_QUERY_LIMITED_INFORMATION` -- is exactly what anti-cheat watches
//! for around a game, and Aether looks at whatever window is in front, which
//! is usually a game. A Toolhelp process snapshot reads executable names from
//! the system's own process list instead, the way Task Manager does: no handle
//! to the game, or to any other program, is ever opened.

#[cfg(windows)]
mod platform {
    use std::{
        sync::Mutex,
        time::{Duration, Instant},
    };

    use windows::Win32::{
        Foundation::CloseHandle,
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    /// A pid reused by another program within this long is not a concern;
    /// snapshotting on every foreground change is avoided.
    const MAX_AGE: Duration = Duration::from_secs(5);

    struct Cache {
        taken: Option<Instant>,
        names: Vec<(u32, String)>,
    }

    impl Cache {
        fn get(&self, pid: u32) -> Option<&String> {
            self.names
                .iter()
                .find(|(seen, _)| *seen == pid)
                .map(|(_, name)| name)
        }
    }

    static CACHE: Mutex<Cache> = Mutex::new(Cache {
        taken: None,
        names: Vec::new(),
    });

    fn snapshot() -> Vec<(u32, String)> {
        let mut names = Vec::new();
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return names;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
            while more {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&unit| unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                names.push((
                    entry.th32ProcessID,
                    String::from_utf16_lossy(&entry.szExeFile[..len]),
                ));
                more = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
        names
    }

    pub fn exe_name(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        let mut cache = CACHE.lock().ok()?;
        let fresh = cache.taken.is_some_and(|taken| taken.elapsed() < MAX_AGE);
        if !fresh || cache.get(pid).is_none() {
            cache.names = snapshot();
            cache.taken = Some(Instant::now());
        }
        cache.get(pid).cloned()
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn exe_name(_: u32) -> Option<String> {
        None
    }
}

/// The executable name (`Aion2.exe`, not a path) of a running process.
pub fn exe_name(pid: u32) -> Option<String> {
    platform::exe_name(pid)
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn names_a_process_from_the_snapshot() {
        let name = super::exe_name(std::process::id()).expect("this process is listed");
        assert!(name.to_ascii_lowercase().ends_with(".exe"), "{name}");
        assert_eq!(super::exe_name(0), None);
    }
}
