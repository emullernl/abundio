/// Cross-platform child process detection.
///
/// Provides a single function `has_child_processes(pid)` that checks whether
/// the given process has any child processes, using platform-native APIs.

/// Returns `true` if the process identified by `pid` has at least one child process.
#[cfg(target_os = "macos")]
pub fn has_child_processes(pid: u32) -> bool {
    extern "C" {
        fn proc_listchildpids(ppid: i32, buffer: *mut i32, buffersize: i32) -> i32;
    }

    let mut buf: [i32; 1] = [0];
    // SAFETY: proc_listchildpids is a stable macOS libproc API. We pass a valid
    // stack-allocated buffer with its correct byte size. The function writes at
    // most `buffersize` bytes and returns the number of bytes written.
    let ret = unsafe {
        proc_listchildpids(
            pid as i32,
            buf.as_mut_ptr(),
            std::mem::size_of_val(&buf) as i32,
        )
    };
    ret > 0
}

/// Returns `true` if the process identified by `pid` has at least one child process.
#[cfg(target_os = "linux")]
pub fn has_child_processes(pid: u32) -> bool {
    let path = format!("/proc/{}/task/{}/children", pid, pid);
    match std::fs::read_to_string(&path) {
        Ok(contents) => !contents.trim().is_empty(),
        Err(_) => false,
    }
}

/// Returns `true` if the process identified by `pid` has at least one child process.
#[cfg(target_os = "windows")]
pub fn has_child_processes(pid: u32) -> bool {
    use std::mem;

    // Windows API constants
    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESSENTRY32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
        fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(hObject: isize) -> i32;
    }

    // SAFETY: We use the Windows Toolhelp API to enumerate processes. The snapshot
    // handle is closed in all code paths. PROCESSENTRY32W is zero-initialized with
    // dwSize set correctly before the first call, as required by the API contract.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }

        let mut entry: PROCESSENTRY32W = mem::zeroed();
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) == 0 {
            CloseHandle(snapshot);
            return false;
        }

        loop {
            if entry.th32ParentProcessID == pid {
                CloseHandle(snapshot);
                return true;
            }
            if Process32NextW(snapshot, &mut entry) == 0 {
                break;
            }
        }

        CloseHandle(snapshot);
        false
    }
}

/// Fallback for unsupported platforms — always returns `false`.
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn has_child_processes(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_returns_without_panic() {
        let pid = std::process::id();
        // Just verify the function doesn't panic — the test runner may or may
        // not have child processes depending on parallel test execution.
        let _ = has_child_processes(pid);
    }

    #[cfg(unix)]
    #[test]
    fn detects_spawned_child() {
        use std::process::Command;
        let child = Command::new("sleep").arg("10").spawn().expect("failed to spawn sleep");
        let pid = std::process::id();
        assert!(has_child_processes(pid));
        // Clean up
        let mut child = child;
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn nonexistent_pid_returns_false() {
        // An absurdly high PID that almost certainly doesn't exist.
        assert!(!has_child_processes(u32::MAX));
    }
}
