use base64::Engine;
use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::error::AbundioError;

const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_FILES: usize = 50_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
	pub name: String,
	pub path: String,
	pub is_dir: bool,
	pub is_symlink: bool,
	pub size: u64,
	pub extension: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
	pub name: String,
	pub path: String,
	pub relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
	pub file_type: String, // "text" | "image" | "binary"
	pub content: Option<String>,
	pub mime: Option<String>,
	pub size: u64,
}

fn extension_to_mime(ext: &str) -> Option<&'static str> {
	match ext {
		"png" => Some("image/png"),
		"jpg" | "jpeg" => Some("image/jpeg"),
		"gif" => Some("image/gif"),
		"webp" => Some("image/webp"),
		"svg" => Some("image/svg+xml"),
		"ico" => Some("image/x-icon"),
		"bmp" => Some("image/bmp"),
		_ => None,
	}
}

fn is_image_ext(ext: &str) -> bool {
	extension_to_mime(ext).is_some()
}

fn is_binary_ext(ext: &str) -> bool {
	matches!(
		ext,
		"exe" | "o" | "so" | "dylib" | "a" | "wasm" | "zip" | "tar" | "gz"
			| "bz2" | "xz" | "7z" | "rar" | "pdf" | "doc" | "docx"
			| "xls" | "xlsx" | "ppt" | "pptx" | "class" | "pyc"
			| "pyo" | "dll" | "lib" | "bin" | "dat" | "db" | "sqlite"
			| "sqlite3" | "ttf" | "otf" | "woff" | "woff2" | "eot"
			| "mp3" | "mp4" | "avi" | "mov" | "mkv" | "flac" | "wav"
			| "ogg" | "jar"
	)
}

fn has_null_bytes(data: &[u8]) -> bool {
	data.iter().any(|&b| b == 0)
}

#[tauri::command]
pub async fn fs_list_dir(path: String) -> Result<Vec<DirEntry>, AbundioError> {
	let dir = Path::new(&path);
	let mut entries = Vec::new();

	for entry in fs::read_dir(dir)? {
		let entry = entry?;
		let name = entry.file_name().to_string_lossy().to_string();

		let file_type = entry.file_type()?;
		let metadata = entry.metadata()?;
		let ext = Path::new(&name)
			.extension()
			.map(|e| e.to_string_lossy().to_lowercase());

		entries.push(DirEntry {
			name,
			path: entry.path().to_string_lossy().to_string(),
			is_dir: file_type.is_dir(),
			is_symlink: file_type.is_symlink(),
			size: metadata.len(),
			extension: ext,
		});
	}

	// Sort: directories first, then alphabetical (case-insensitive)
	entries.sort_by(|a, b| {
		b.is_dir
			.cmp(&a.is_dir)
			.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
	});

	Ok(entries)
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<FileContent, AbundioError> {
	let file_path = Path::new(&path);
	let metadata = fs::metadata(file_path)?;
	let size = metadata.len();

	// Check executable bit (Unix only — Windows has no permission bits)
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let perms = metadata.permissions();
		if perms.mode() & 0o111 != 0 && !metadata.is_dir() {
			let ext = file_path
				.extension()
				.map(|e| e.to_string_lossy().to_lowercase())
				.unwrap_or_default();

			if ext.is_empty() || is_binary_ext(&ext) {
				return Ok(FileContent {
					file_type: "binary".to_string(),
					content: None,
					mime: None,
					size,
				});
			}
		}
	}

	let ext = file_path
		.extension()
		.map(|e| e.to_string_lossy().to_lowercase())
		.unwrap_or_default();

	// Image files
	if is_image_ext(&ext) {
		if size > MAX_FILE_SIZE {
			return Ok(FileContent {
				file_type: "binary".to_string(),
				content: None,
				mime: None,
				size,
			});
		}
		let bytes = fs::read(file_path)?;
		let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
		return Ok(FileContent {
			file_type: "image".to_string(),
			content: Some(b64),
			mime: Some(extension_to_mime(&ext).unwrap_or("application/octet-stream").to_string()),
			size,
		});
	}

	// Known binary extensions
	if is_binary_ext(&ext) {
		return Ok(FileContent {
			file_type: "binary".to_string(),
			content: None,
			mime: None,
			size,
		});
	}

	// Size guard for text files
	if size > MAX_FILE_SIZE {
		return Ok(FileContent {
			file_type: "binary".to_string(),
			content: None,
			mime: None,
			size,
		});
	}

	// Try reading as text — check for null bytes in first 8KB
	let bytes = fs::read(file_path)?;
	let check_len = bytes.len().min(8192);
	if has_null_bytes(&bytes[..check_len]) {
		return Ok(FileContent {
			file_type: "binary".to_string(),
			content: None,
			mime: None,
			size,
		});
	}

	let text = String::from_utf8_lossy(&bytes).to_string();
	Ok(FileContent {
		file_type: "text".to_string(),
		content: Some(text),
		mime: None,
		size,
	})
}

#[tauri::command]
pub async fn fs_write_file(path: String, content: String) -> Result<(), AbundioError> {
	fs::write(&path, content)?;
	Ok(())
}

#[tauri::command]
pub async fn fs_file_exists(path: String) -> Result<bool, AbundioError> {
	Ok(Path::new(&path).exists())
}

#[tauri::command]
pub async fn fs_list_files(
	root_path: String,
	max_files: Option<usize>,
) -> Result<Vec<FileEntry>, AbundioError> {
	let max = max_files.unwrap_or(DEFAULT_MAX_FILES);
	tokio::task::spawn_blocking(move || list_files_inner(&root_path, max))
		.await
		.map_err(|e| AbundioError::Search(format!("File listing task failed: {}", e)))?
}

fn list_files_inner(root_path: &str, max_files: usize) -> Result<Vec<FileEntry>, AbundioError> {
	let root = Path::new(root_path);
	let walker = WalkBuilder::new(root)
		.hidden(true)
		.git_ignore(true)
		.git_global(true)
		.git_exclude(true)
		.build();

	let mut out = Vec::new();
	for entry in walker {
		if out.len() >= max_files {
			break;
		}
		let entry = match entry {
			Ok(e) => e,
			Err(_) => continue,
		};
		if !entry.file_type().map_or(false, |ft| ft.is_file()) {
			continue;
		}
		let path = entry.path();
		let rel = path.strip_prefix(root).unwrap_or(path);
		let relative_path = rel.to_string_lossy().to_string();
		let name = path
			.file_name()
			.map(|n| n.to_string_lossy().to_string())
			.unwrap_or_default();
		out.push(FileEntry {
			name,
			path: path.to_string_lossy().to_string(),
			relative_path,
		});
	}
	Ok(out)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn extension_to_mime_known() {
		assert_eq!(extension_to_mime("png"), Some("image/png"));
		assert_eq!(extension_to_mime("jpg"), Some("image/jpeg"));
		assert_eq!(extension_to_mime("jpeg"), Some("image/jpeg"));
		assert_eq!(extension_to_mime("gif"), Some("image/gif"));
		assert_eq!(extension_to_mime("webp"), Some("image/webp"));
		assert_eq!(extension_to_mime("svg"), Some("image/svg+xml"));
		assert_eq!(extension_to_mime("ico"), Some("image/x-icon"));
		assert_eq!(extension_to_mime("bmp"), Some("image/bmp"));
	}

	#[test]
	fn extension_to_mime_unknown() {
		assert_eq!(extension_to_mime("txt"), None);
		assert_eq!(extension_to_mime("rs"), None);
		assert_eq!(extension_to_mime("pdf"), None);
	}

	#[test]
	fn is_image_ext_true() {
		for ext in &["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"] {
			assert!(is_image_ext(ext), "{} should be image", ext);
		}
	}

	#[test]
	fn is_image_ext_false() {
		assert!(!is_image_ext("txt"));
		assert!(!is_image_ext("pdf"));
		assert!(!is_image_ext("rs"));
	}

	#[test]
	fn is_binary_ext_true() {
		for ext in &["exe", "zip", "pdf", "wasm", "sqlite3", "jar", "dll", "mp3"] {
			assert!(is_binary_ext(ext), "{} should be binary", ext);
		}
	}

	#[test]
	fn is_binary_ext_false() {
		assert!(!is_binary_ext("txt"));
		assert!(!is_binary_ext("rs"));
		assert!(!is_binary_ext("js"));
		assert!(!is_binary_ext("html"));
	}

	#[test]
	fn has_null_bytes_true() {
		assert!(has_null_bytes(b"hel\0lo"));
		assert!(has_null_bytes(&[0u8]));
	}

	#[test]
	fn has_null_bytes_false() {
		assert!(!has_null_bytes(b"hello"));
		assert!(!has_null_bytes(b""));
	}

	fn make_file(dir: &Path, rel: &str, body: &str) {
		let full = dir.join(rel);
		if let Some(parent) = full.parent() {
			fs::create_dir_all(parent).unwrap();
		}
		fs::write(full, body).unwrap();
	}

	#[test]
	fn list_files_returns_all_plain_files() {
		let tmp = tempfile::TempDir::new().unwrap();
		make_file(tmp.path(), "a.txt", "a");
		make_file(tmp.path(), "sub/b.txt", "b");
		make_file(tmp.path(), "sub/nested/c.txt", "c");

		let files = list_files_inner(tmp.path().to_str().unwrap(), 100).unwrap();
		let rels: Vec<String> = files.iter().map(|f| f.relative_path.clone()).collect();
		assert_eq!(rels.len(), 3);
		assert!(rels.iter().any(|r| r == "a.txt"));
		assert!(rels.iter().any(|r| r.ends_with("b.txt") && r.contains("sub")));
		assert!(rels.iter().any(|r| r.ends_with("c.txt")));
	}

	#[test]
	fn list_files_respects_gitignore() {
		let tmp = tempfile::TempDir::new().unwrap();
		// WalkBuilder only applies gitignore inside a git repo, so mark it as one.
		fs::create_dir_all(tmp.path().join(".git")).unwrap();
		make_file(tmp.path(), ".gitignore", "ignored.txt\nbuild/\n");
		make_file(tmp.path(), "kept.txt", "k");
		make_file(tmp.path(), "ignored.txt", "x");
		make_file(tmp.path(), "build/out.txt", "x");

		let files = list_files_inner(tmp.path().to_str().unwrap(), 100).unwrap();
		let rels: Vec<String> = files.iter().map(|f| f.relative_path.clone()).collect();
		assert!(rels.iter().any(|r| r == "kept.txt"));
		assert!(!rels.iter().any(|r| r == "ignored.txt"));
		assert!(!rels.iter().any(|r| r.starts_with("build")));
	}

	#[test]
	fn list_files_skips_hidden_and_git_dir() {
		let tmp = tempfile::TempDir::new().unwrap();
		fs::create_dir_all(tmp.path().join(".git")).unwrap();
		make_file(tmp.path(), ".git/HEAD", "ref: refs/heads/main");
		make_file(tmp.path(), ".env", "SECRET=1");
		make_file(tmp.path(), "visible.txt", "v");

		let files = list_files_inner(tmp.path().to_str().unwrap(), 100).unwrap();
		let rels: Vec<String> = files.iter().map(|f| f.relative_path.clone()).collect();
		assert!(rels.iter().any(|r| r == "visible.txt"));
		assert!(!rels.iter().any(|r| r.starts_with(".git")));
		assert!(!rels.iter().any(|r| r == ".env"));
	}

	#[test]
	fn list_files_respects_max_cap() {
		let tmp = tempfile::TempDir::new().unwrap();
		for i in 0..20 {
			make_file(tmp.path(), &format!("f{}.txt", i), "x");
		}
		let files = list_files_inner(tmp.path().to_str().unwrap(), 5).unwrap();
		assert_eq!(files.len(), 5);
	}

	#[test]
	fn list_files_relative_path_is_relative() {
		let tmp = tempfile::TempDir::new().unwrap();
		make_file(tmp.path(), "dir/x.txt", "x");
		let files = list_files_inner(tmp.path().to_str().unwrap(), 100).unwrap();
		let entry = files.iter().find(|f| f.name == "x.txt").unwrap();
		assert!(entry.path.contains("x.txt"));
		assert!(!entry.relative_path.starts_with('/'));
		assert!(entry.relative_path.contains("x.txt"));
	}
}
