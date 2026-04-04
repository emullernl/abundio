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

/// Known interpreter basenames — when argv[0] is one of these, the actual
/// command name is in a later argv entry.
const INTERPRETERS: &[&str] = &["env", "node", "python", "python3", "ruby", "perl", "bash", "sh", "zsh"];

/// Read process argv via sysctl KERN_PROCARGS2 and return the effective command
/// basename. For directly-invoked binaries this is argv[0]'s basename. For
/// interpreter-launched scripts (`/usr/bin/env node /path/to/opencode`), this
/// skips the interpreter and its flags to find the script basename.
#[cfg(target_os = "macos")]
fn get_command_name(pid: i32) -> Option<String> {
    extern "C" {
        fn sysctl(
            name: *mut i32,
            namelen: u32,
            oldp: *mut std::ffi::c_void,
            oldlenp: *mut usize,
            newp: *mut std::ffi::c_void,
            newlen: usize,
        ) -> i32;
    }

    const CTL_KERN: i32 = 1;
    const KERN_PROCARGS2: i32 = 49;

    let mut mib = [CTL_KERN, KERN_PROCARGS2, pid];
    let mut size: usize = 0;

    // SAFETY: First call with null buffer to get required size.
    if unsafe { sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    if size == 0 { return None; }

    let mut buf = vec![0u8; size];
    // SAFETY: Second call fills the buffer with process arguments.
    if unsafe { sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr() as *mut _, &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }

    // Format: argc (4 bytes) | exec_path (null-terminated) | null padding | argv[0] | argv[1] | ...
    if size < 4 { return None; }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if argc < 1 { return None; }

    // Skip exec_path
    let mut pos = 4;
    while pos < size && buf[pos] != 0 { pos += 1; }
    // Skip null padding
    while pos < size && buf[pos] == 0 { pos += 1; }

    // Read all argv entries
    let mut args = Vec::with_capacity(argc);
    for _ in 0..argc {
        if pos >= size { break; }
        let start = pos;
        while pos < size && buf[pos] != 0 { pos += 1; }
        if let Ok(s) = std::str::from_utf8(&buf[start..pos]) {
            args.push(s.to_string());
        }
        pos += 1; // skip null terminator
    }

    // Find the first arg that isn't an interpreter or a flag.
    // e.g. ["/usr/bin/env", "node", "/usr/local/bin/opencode", "--version"]
    //       → skip "env", skip "node", return "opencode"
    for arg in &args {
        if arg.starts_with('-') { continue; } // skip flags
        let basename = arg.rsplit('/').next().unwrap_or(arg);
        if basename.is_empty() { continue; }
        if INTERPRETERS.contains(&basename) { continue; }
        return Some(basename.to_string());
    }

    None
}

/// Returns executable names of all direct child processes of the given PID.
/// Uses argv[0] basename so symlinked commands (e.g. `claude` → versioned binary)
/// report the name the user actually invoked.
#[cfg(target_os = "macos")]
pub fn get_child_process_names(pid: u32) -> Vec<String> {
    extern "C" {
        fn proc_listchildpids(ppid: i32, buffer: *mut i32, buffersize: i32) -> i32;
    }

    const MAX_CHILDREN: usize = 64;

    let mut child_pids = [0i32; MAX_CHILDREN];
    // SAFETY: proc_listchildpids writes child PIDs into the buffer and returns
    // the number of PIDs written (not bytes).
    let num_pids = unsafe {
        proc_listchildpids(
            pid as i32,
            child_pids.as_mut_ptr(),
            std::mem::size_of_val(&child_pids) as i32,
        )
    };
    if num_pids <= 0 {
        return Vec::new();
    }

    let count = (num_pids as usize).min(MAX_CHILDREN);
    let mut names = Vec::with_capacity(count);

    for &cpid in &child_pids[..count] {
        if let Some(name) = get_command_name(cpid) {
            names.push(name);
        }
    }
    names
}

/// Returns executable names of all direct child processes of the given PID.
#[cfg(target_os = "linux")]
pub fn get_child_process_names(pid: u32) -> Vec<String> {
    let mut child_pids = Vec::new();

    // Fast path: /proc/{pid}/task/{pid}/children
    let path = format!("/proc/{}/task/{}/children", pid, pid);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        for token in contents.split_whitespace() {
            if let Ok(cpid) = token.parse::<u32>() {
                child_pids.push(cpid);
            }
        }
    }

    // Fallback: scan /proc/*/stat
    if child_pids.is_empty() {
        let entries = match std::fs::read_dir("/proc") {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let stat_path = format!("/proc/{}/stat", name);
            if let Ok(stat) = std::fs::read_to_string(&stat_path) {
                if let Some(after_comm) = stat.rfind(')') {
                    let fields: Vec<&str> = stat[after_comm + 1..].split_whitespace().collect();
                    if let Some(ppid_str) = fields.get(1) {
                        if ppid_str.parse::<u32>().ok() == Some(pid) {
                            if let Ok(cpid) = name.parse::<u32>() {
                                child_pids.push(cpid);
                            }
                        }
                    }
                }
            }
        }
    }

    child_pids
        .iter()
        .filter_map(|cpid| {
            // Parse cmdline (null-separated argv) and skip interpreters
            if let Ok(cmdline) = std::fs::read(format!("/proc/{}/cmdline", cpid)) {
                let args: Vec<&str> = cmdline
                    .split(|&b| b == 0)
                    .filter_map(|s| std::str::from_utf8(s).ok())
                    .filter(|s| !s.is_empty())
                    .collect();
                for arg in &args {
                    if arg.starts_with('-') { continue; }
                    let basename = arg.rsplit('/').next().unwrap_or(arg);
                    if basename.is_empty() { continue; }
                    if INTERPRETERS.contains(&basename) { continue; }
                    return Some(basename.to_string());
                }
            }
            // Fallback to comm
            std::fs::read_to_string(format!("/proc/{}/comm", cpid))
                .ok()
                .map(|s| s.trim().to_string())
        })
        .collect()
}

/// Returns `true` if the process identified by `pid` has at least one child process.
#[cfg(target_os = "linux")]
pub fn has_child_processes(pid: u32) -> bool {
    // Fast path: /proc/{pid}/task/{pid}/children (requires CONFIG_PROC_CHILDREN).
    // Note: this file is per-thread, so it may miss children spawned from
    // non-main threads. On miss, fall through to the /proc scan below.
    let path = format!("/proc/{}/task/{}/children", pid, pid);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        if !contents.trim().is_empty() {
            return true;
        }
    }

    // Fallback: scan /proc/*/stat for processes whose ppid matches
    let entries = match std::fs::read_dir("/proc") {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let stat_path = format!("/proc/{}/stat", name);
        if let Ok(stat) = std::fs::read_to_string(&stat_path) {
            // Format: "pid (comm) state ppid ..." — find ppid after the last ')'
            if let Some(after_comm) = stat.rfind(')') {
                let fields: Vec<&str> = stat[after_comm + 1..].split_whitespace().collect();
                // fields[0] = state, fields[1] = ppid
                if let Some(ppid_str) = fields.get(1) {
                    if ppid_str.parse::<u32>().ok() == Some(pid) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Returns executable names of all direct child processes of the given PID.
#[cfg(target_os = "windows")]
pub fn get_child_process_names(pid: u32) -> Vec<String> {
    use std::mem;

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

    let mut names = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return names;
        }

        let mut entry: PROCESSENTRY32W = mem::zeroed();
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut entry) == 0 {
            CloseHandle(snapshot);
            return names;
        }

        loop {
            if entry.th32ParentProcessID == pid {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(260);
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                // Strip .exe suffix if present
                let name = name.strip_suffix(".exe").unwrap_or(&name).to_string();
                names.push(name);
            }
            if Process32NextW(snapshot, &mut entry) == 0 {
                break;
            }
        }

        CloseHandle(snapshot);
    }
    names
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

/// Fallback for unsupported platforms — always returns empty vec.
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn get_child_process_names(_pid: u32) -> Vec<String> {
    Vec::new()
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

    #[cfg(unix)]
    #[test]
    fn get_child_names_includes_spawned_process() {
        use std::process::Command;
        let child = Command::new("sleep").arg("10").spawn().expect("failed to spawn sleep");
        let pid = std::process::id();
        // Allow the process to fully start so the OS can report its name
        std::thread::sleep(std::time::Duration::from_millis(50));
        let names = get_child_process_names(pid);
        assert!(names.iter().any(|n| n == "sleep"), "expected 'sleep' in {:?}", names);
        let mut child = child;
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn get_child_names_empty_for_nonexistent_pid() {
        assert!(get_child_process_names(u32::MAX).is_empty());
    }
}
