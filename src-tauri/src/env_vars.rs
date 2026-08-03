//! Per-Workspace environment variables, grouped into named Bundles.
//!
//! A Workspace owns one or more **Bundles**. Exactly one is *injected* — its
//! variables go into every PTY's environment at spawn. The rest are *on-demand*
//! and never enter any process environment; they are read only through the
//! `abundio-env` helper (see `hook_server.rs`).
//!
//! A linked git worktree inherits its main worktree's Bundles **by name**, and
//! an own variable of the same name overrides the inherited one. The caller
//! supplies the main-worktree Workspace id — worktree grouping is derived in
//! the frontend (`src/lib/worktreeGrouping.ts`) and is not recomputed here.
//!
//! ## Plaintext boundary
//!
//! Only [`EnvVarStore::reveal`] and the resolve methods produce plaintext.
//! [`EnvVarStore::list`] returns names and byte lengths so the settings UI can
//! render without ever holding a secret. Keep it that way — the frontend heap
//! is a much larger attack surface than this process.

use std::collections::HashSet;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::env_crypto::{self, MasterKey};
use crate::error::AbundioError;

/// Name of the Bundle created automatically for a Workspace's first variable.
pub const DEFAULT_BUNDLE: &str = "default";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleMeta {
    pub id: String,
    /// The Workspace that owns this Bundle. For an inherited Bundle this is the
    /// main worktree, not the Workspace that was queried.
    pub workspace_id: String,
    pub name: String,
    pub injected: bool,
    pub position: i32,
    pub var_count: i32,
    /// True when this Bundle exists only on the main worktree.
    pub inherited: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVarMeta {
    pub id: String,
    pub bundle_id: String,
    pub name: String,
    /// Plaintext byte length, derived as `ciphertext.len() - TAG_LEN`. Never a
    /// decryption.
    pub byte_len: i64,
    pub position: i32,
    /// True when this value comes from the main worktree rather than the
    /// queried Workspace.
    pub inherited: bool,
    /// True when the value could not be opened under the current master key —
    /// e.g. the database was restored onto a machine without the key. The row
    /// renders locked: visible and deletable, but not expandable.
    pub undecryptable: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvListResult {
    pub bundles: Vec<BundleMeta>,
    /// The Bundle the `vars` belong to, after defaulting.
    pub selected_bundle: String,
    pub vars: Vec<EnvVarMeta>,
    /// `None` when the master key is available. `Some(reason)` when the
    /// credential store is missing, locked or denied — the UI shows a banner
    /// with Retry and every row renders locked.
    pub key_error: Option<String>,
    /// Resolved size of the injected Bundle, and the platform budget. Lets the
    /// add form disable itself before a write would be rejected.
    pub bytes_used: i64,
    pub bytes_budget: i64,
}

/// What a terminal spawned right now would receive. Names and counts only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectedSummary {
    pub bundle: String,
    /// Variables the Bundle resolves to, inherited ones included.
    pub var_count: i32,
    /// True when the Bundle comes from the main worktree.
    pub inherited: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVarInput {
    pub name: String,
    pub value: String,
}

/// Owns its own SQLite connection.
///
/// Deliberately separate from `WorkspaceStore`: resolving a Workspace's
/// environment happens on the PTY spawn hot path, and must not queue behind the
/// workspace mutex while a git or telemetry write holds it. WAL mode makes
/// concurrent readers safe.
pub struct EnvVarStore {
    pub conn: Mutex<Connection>,
}

/// One bundle row, used internally before it becomes a `BundleMeta`.
struct BundleRow {
    id: String,
    workspace_id: String,
    name: String,
    injected: bool,
    position: i32,
}

impl EnvVarStore {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    // ── Reads ──

    /// Bundles and the variables of one Bundle. Never returns plaintext.
    ///
    /// `key` is passed in rather than fetched here so this method stays
    /// testable without a credential store. `None` means the key is
    /// unavailable: names still render and every value reports as locked. The
    /// caller fills in `key_error` with the reason.
    pub fn list(
        &self,
        workspace_id: &str,
        inherit_from: Option<&str>,
        bundle: Option<&str>,
        key: Option<&MasterKey>,
    ) -> Result<EnvListResult, AbundioError> {
        let conn = self.conn.lock().unwrap();

        let bundles = merged_bundles(&conn, workspace_id, inherit_from)?;

        // Pick the requested Bundle, else the injected one, else the first.
        let selected = bundle
            .filter(|b| bundles.iter().any(|x| x.name == *b))
            .map(|b| b.to_string())
            .or_else(|| bundles.iter().find(|b| b.injected).map(|b| b.name.clone()))
            .or_else(|| bundles.first().map(|b| b.name.clone()))
            .unwrap_or_else(|| DEFAULT_BUNDLE.to_string());

        let vars = merged_vars(&conn, workspace_id, inherit_from, &selected, key)?;

        // Budget is measured against the injected Bundle as it will actually be
        // resolved at spawn, inheritance included — that is what lands in the
        // environment block.
        // With injection off nothing lands in any environment block, so the
        // budget is zero — not `default`'s size, which would raise an
        // over-budget banner about a Bundle that is neither selected nor
        // injected.
        let injected_vars = match bundles.iter().find(|b| b.injected) {
            None => Vec::new(),
            Some(b) if b.name == selected => vars.clone(),
            Some(b) => merged_vars(&conn, workspace_id, inherit_from, &b.name, key)?,
        };
        // Must match what `build_env_injection` will actually consume, or the
        // add form would accept a variable the spawn path then drops.
        let bytes_used: i64 = injected_vars
            .iter()
            .map(|v| {
                env_crypto::injection_cost(v.name.len(), v.byte_len.max(0) as usize) as i64
            })
            .sum();

        Ok(EnvListResult {
            bundles,
            selected_bundle: selected,
            vars,
            key_error: None,
            bytes_used,
            bytes_budget: env_crypto::MAX_INJECTED_BYTES as i64,
        })
    }

    /// Plaintext for a single variable. The only path that hands a secret to
    /// the frontend, and only on an explicit user expand.
    pub fn reveal(
        &self,
        key: &MasterKey,
        workspace_id: &str,
        inherit_from: Option<&str>,
        bundle: &str,
        name: &str,
    ) -> Result<String, AbundioError> {
        let conn = self.conn.lock().unwrap();

        // Own value wins; fall back to the inherited Bundle of the same name.
        let mut sources = vec![workspace_id];
        if let Some(parent) = inherit_from {
            sources.push(parent);
        }
        for source in sources {
            if let Some((nonce, ciphertext)) = lookup_var(&conn, source, bundle, name)? {
                let plain = env_crypto::open(key, name, &nonce, &ciphertext)?;
                return String::from_utf8(plain.to_vec())
                    .map_err(|_| AbundioError::Crypto("value is not valid UTF-8".to_string()));
            }
        }
        Err(AbundioError::NotFound(format!(
            "environment variable {name}"
        )))
    }

    /// Whether this Workspace's injected Bundle holds anything at all.
    ///
    /// Deliberately requires no master key: it runs on every PTY spawn, and
    /// asking the OS credential store there would pop a Keychain prompt at the
    /// first terminal for users who never touch this feature — and would create
    /// a key they never asked for.
    pub fn has_injected_vars(
        &self,
        workspace_id: &str,
        inherit_from: Option<&str>,
    ) -> Result<bool, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let bundles = merged_bundles(&conn, workspace_id, inherit_from)?;
        let Some(injected) = bundles.iter().find(|b| b.injected) else {
            return Ok(false);
        };
        let mut sources = vec![workspace_id];
        if let Some(parent) = inherit_from {
            sources.push(parent);
        }
        for source in sources {
            if let Some(row) = find_bundle(&conn, source, &injected.name)? {
                if var_count(&conn, &row.id)? > 0 {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// The injected Bundle, fully resolved, for PTY spawn.
    ///
    /// Rows that fail to open are skipped with a log line rather than returning
    /// an error: a credential problem must never prevent a terminal opening.
    pub fn resolve_for_spawn(
        &self,
        key: &MasterKey,
        workspace_id: &str,
        inherit_from: Option<&str>,
    ) -> Result<Vec<(String, Zeroizing<String>)>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let bundles = merged_bundles(&conn, workspace_id, inherit_from)?;
        let Some(injected) = bundles.iter().find(|b| b.injected) else {
            return Ok(Vec::new());
        };
        resolve_pairs(&conn, key, workspace_id, inherit_from, &injected.name)
    }

    /// A named Bundle, fully resolved. Backs `abundio-env print <bundle>`.
    pub fn resolve_bundle(
        &self,
        key: &MasterKey,
        workspace_id: &str,
        inherit_from: Option<&str>,
        bundle: &str,
    ) -> Result<Vec<(String, Zeroizing<String>)>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let bundles = merged_bundles(&conn, workspace_id, inherit_from)?;
        if !bundles.iter().any(|b| b.name == bundle) {
            return Err(AbundioError::NotFound(format!("bundle {bundle}")));
        }
        resolve_pairs(&conn, key, workspace_id, inherit_from, bundle)
    }

    /// Bundle names visible to a Workspace. Backs `abundio-env list`.
    pub fn bundle_names(
        &self,
        workspace_id: &str,
        inherit_from: Option<&str>,
    ) -> Result<Vec<String>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        Ok(merged_bundles(&conn, workspace_id, inherit_from)?
            .into_iter()
            .map(|b| b.name)
            .collect())
    }

    // ── Bundle mutations ──

    pub fn create_bundle(
        &self,
        workspace_id: &str,
        inherit_from: Option<&str>,
        name: &str,
    ) -> Result<BundleMeta, AbundioError> {
        env_crypto::validate_bundle_name(name)?;
        let name = name.trim();
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if find_bundle(&tx, workspace_id, name)?.is_some() {
            return Err(AbundioError::InvalidOperation(format!(
                "A bundle named '{name}' already exists"
            )));
        }
        let row = create_own_bundle(&tx, workspace_id, inherit_from, name)?;
        tx.commit()?;
        Ok(to_meta(row, 0, false))
    }

    pub fn rename_bundle(
        &self,
        workspace_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), AbundioError> {
        env_crypto::validate_bundle_name(to)?;
        let to = to.trim();
        let conn = self.conn.lock().unwrap();
        let Some(row) = find_bundle(&conn, workspace_id, from)? else {
            return Err(AbundioError::NotFound(format!("bundle {from}")));
        };
        if from != to && find_bundle(&conn, workspace_id, to)?.is_some() {
            return Err(AbundioError::InvalidOperation(format!(
                "A bundle named '{to}' already exists"
            )));
        }
        conn.execute(
            "UPDATE workspace_env_bundles SET name = ?1, updated_at = unixepoch() WHERE id = ?2",
            params![to, row.id],
        )?;
        Ok(())
    }

    /// Mark a Bundle injected, clearing the flag on its siblings in the same
    /// transaction. The partial unique index would reject the write otherwise.
    pub fn set_injected(&self, workspace_id: &str, name: &str) -> Result<(), AbundioError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let Some(row) = find_bundle(&tx, workspace_id, name)? else {
            return Err(AbundioError::NotFound(format!("bundle {name}")));
        };
        tx.execute(
            "UPDATE workspace_env_bundles SET injected = 0, updated_at = unixepoch()
             WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        tx.execute(
            "UPDATE workspace_env_bundles SET injected = 1, updated_at = unixepoch() WHERE id = ?1",
            params![row.id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Turn injection off entirely: no Bundle is injected, so new terminals in
    /// this Workspace start with a plain environment. Every Bundle stays put and
    /// remains readable on demand via `abundio-env`.
    ///
    /// A linked worktree needs more than clearing its own flags: it *inherits*
    /// the main worktree's injected Bundle, and inheritance would put the
    /// environment straight back. So shadow that Bundle with an own row carrying
    /// `injected = 0` — the same override mechanism used for values, applied to
    /// the role. Its variables still resolve through inheritance, so nothing is
    /// lost; only the injection stops.
    pub fn clear_injected(
        &self,
        workspace_id: &str,
        inherit_from: Option<&str>,
    ) -> Result<(), AbundioError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE workspace_env_bundles SET injected = 0, updated_at = unixepoch()
             WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        if let Some(parent) = inherit_from {
            for row in bundles_of(&tx, parent)? {
                if row.injected && find_bundle(&tx, workspace_id, &row.name)?.is_none() {
                    insert_bundle(&tx, workspace_id, &row.name, false)?;
                }
            }
        } else if bundles_of(&tx, workspace_id)?.is_empty() {
            // A Workspace with no rows yet is *shown* the placeholder `default`
            // as injected — which is what its first variable would create. The
            // UPDATE above matches nothing there, so without materialising the
            // row the toggle would flip straight back to "Injected".
            insert_bundle(&tx, workspace_id, DEFAULT_BUNDLE, false)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Which Bundle a terminal spawned right now would receive, and how many
    /// variables it resolves to. `None` when injection is off.
    ///
    /// Needs no master key — it counts rows, never opens them — so the status
    /// pill can ask for it on every Workspace switch without touching the OS
    /// credential store.
    pub fn injected_summary(
        &self,
        workspace_id: &str,
        inherit_from: Option<&str>,
    ) -> Result<Option<InjectedSummary>, AbundioError> {
        let conn = self.conn.lock().unwrap();
        let bundles = merged_bundles(&conn, workspace_id, inherit_from)?;
        let Some(injected) = bundles.iter().find(|b| b.injected) else {
            return Ok(None);
        };
        let vars = merged_vars(&conn, workspace_id, inherit_from, &injected.name, None)?;
        Ok(Some(InjectedSummary {
            bundle: injected.name.clone(),
            var_count: vars.len() as i32,
            inherited: injected.inherited,
        }))
    }

    /// Delete a Bundle and its variables. The last Bundle cannot be deleted;
    /// deleting the injected one promotes the next by position.
    pub fn delete_bundle(&self, workspace_id: &str, name: &str) -> Result<(), AbundioError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let Some(row) = find_bundle(&tx, workspace_id, name)? else {
            return Err(AbundioError::NotFound(format!("bundle {name}")));
        };
        let total: i64 = tx.query_row(
            "SELECT COUNT(*) FROM workspace_env_bundles WHERE workspace_id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )?;
        if total <= 1 {
            return Err(AbundioError::InvalidOperation(
                "A workspace must keep at least one bundle".into(),
            ));
        }
        let was_injected = row.injected;
        tx.execute(
            "DELETE FROM workspace_env_bundles WHERE id = ?1",
            params![row.id],
        )?;
        if was_injected {
            // Promote the next Bundle so the Workspace always has exactly one
            // injected Bundle — the spawn path relies on finding it.
            if let Some(next) = tx
                .query_row(
                    "SELECT id FROM workspace_env_bundles WHERE workspace_id = ?1
                     ORDER BY position ASC, name ASC LIMIT 1",
                    params![workspace_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                tx.execute(
                    "UPDATE workspace_env_bundles SET injected = 1 WHERE id = ?1",
                    params![next],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ── Variable mutations ──

    /// Insert or replace one variable. Creates the Bundle on the queried
    /// Workspace if it exists only on the main worktree — that is how editing
    /// an inherited value becomes an override.
    pub fn upsert(
        &self,
        key: &MasterKey,
        workspace_id: &str,
        inherit_from: Option<&str>,
        bundle: &str,
        name: &str,
        value: &str,
    ) -> Result<EnvVarMeta, AbundioError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let meta = upsert_one(&tx, key, workspace_id, inherit_from, bundle, name, value)?;
        tx.commit()?;
        Ok(meta)
    }

    /// Bulk import. All-or-nothing: one invalid name aborts the whole paste, so
    /// a `.env` import can never land half-applied.
    pub fn upsert_many(
        &self,
        key: &MasterKey,
        workspace_id: &str,
        inherit_from: Option<&str>,
        bundle: &str,
        entries: &[EnvVarInput],
    ) -> Result<Vec<EnvVarMeta>, AbundioError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            out.push(upsert_one(
                &tx,
                key,
                workspace_id,
                inherit_from,
                bundle,
                &entry.name,
                &entry.value,
            )?);
        }
        tx.commit()?;
        Ok(out)
    }

    pub fn delete(&self, workspace_id: &str, bundle: &str, name: &str) -> Result<(), AbundioError> {
        let conn = self.conn.lock().unwrap();
        let Some(row) = find_bundle(&conn, workspace_id, bundle)? else {
            return Err(AbundioError::NotFound(format!("bundle {bundle}")));
        };
        conn.execute(
            "DELETE FROM workspace_env_vars WHERE bundle_id = ?1 AND name = ?2",
            params![row.id, name],
        )?;
        Ok(())
    }

    pub fn reorder(
        &self,
        workspace_id: &str,
        bundle: &str,
        names: &[String],
    ) -> Result<(), AbundioError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let Some(row) = find_bundle(&tx, workspace_id, bundle)? else {
            return Err(AbundioError::NotFound(format!("bundle {bundle}")));
        };
        for (i, name) in names.iter().enumerate() {
            tx.execute(
                "UPDATE workspace_env_vars SET position = ?1 WHERE bundle_id = ?2 AND name = ?3",
                params![i as i32, row.id, name],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

// ── Free helpers (take a &Connection so they work inside a transaction too) ──

/// Create the Workspace's own copy of `bundle`, deciding the injected flag from
/// context.
///
/// This is subtle and was previously wrong. A Workspace's first bundle should
/// normally become the injected one — but a linked worktree that *inherits* an
/// injected bundle already has an environment, and marking a freshly-created
/// local bundle injected would shadow it and leave the worktree with nothing.
/// So: when overriding an inherited bundle, mirror the parent's flag; otherwise
/// only claim injected if nothing else already provides one.
fn create_own_bundle(
    conn: &Connection,
    workspace_id: &str,
    inherit_from: Option<&str>,
    bundle: &str,
) -> Result<BundleRow, AbundioError> {
    env_crypto::validate_bundle_name(bundle)?;

    let inherited_same_name =
        inherit_from.and_then(|parent| find_bundle(conn, parent, bundle).ok().flatten());

    let injected = match inherited_same_name {
        // Overriding an inherited bundle: keep whatever role it already had.
        Some(parent_row) => parent_row.injected,
        None => {
            let own: i64 = conn.query_row(
                "SELECT COUNT(*) FROM workspace_env_bundles WHERE workspace_id = ?1",
                params![workspace_id],
                |r| r.get(0),
            )?;
            let inherits_injected = match inherit_from {
                Some(parent) => bundles_of(conn, parent)?.iter().any(|b| b.injected),
                None => false,
            };
            own == 0 && !inherits_injected
        }
    };

    // At most one injected bundle per Workspace — the partial unique index
    // would otherwise reject this insert.
    if injected {
        conn.execute(
            "UPDATE workspace_env_bundles SET injected = 0 WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
    }
    insert_bundle(conn, workspace_id, bundle, injected)
}

fn insert_bundle(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
    injected: bool,
) -> Result<BundleRow, AbundioError> {
    let position: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM workspace_env_bundles
             WHERE workspace_id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO workspace_env_bundles (id, workspace_id, name, injected, position)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, workspace_id, name, injected as i32, position],
    )?;
    Ok(BundleRow {
        id,
        workspace_id: workspace_id.to_string(),
        name: name.to_string(),
        injected,
        position,
    })
}

fn find_bundle(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
) -> Result<Option<BundleRow>, AbundioError> {
    Ok(conn
        .query_row(
            "SELECT id, workspace_id, name, injected, position FROM workspace_env_bundles
             WHERE workspace_id = ?1 AND name = ?2",
            params![workspace_id, name],
            |r| {
                Ok(BundleRow {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    name: r.get(2)?,
                    injected: r.get::<_, i32>(3)? != 0,
                    position: r.get(4)?,
                })
            },
        )
        .optional()?)
}

fn bundles_of(conn: &Connection, workspace_id: &str) -> Result<Vec<BundleRow>, AbundioError> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, name, injected, position FROM workspace_env_bundles
         WHERE workspace_id = ?1 ORDER BY position ASC, name ASC",
    )?;
    let rows = stmt
        .query_map(params![workspace_id], |r| {
            Ok(BundleRow {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                name: r.get(2)?,
                injected: r.get::<_, i32>(3)? != 0,
                position: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn var_count(conn: &Connection, bundle_id: &str) -> Result<i32, AbundioError> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM workspace_env_vars WHERE bundle_id = ?1",
        params![bundle_id],
        |r| r.get(0),
    )?)
}

fn to_meta(row: BundleRow, var_count: i32, inherited: bool) -> BundleMeta {
    BundleMeta {
        id: row.id,
        workspace_id: row.workspace_id,
        name: row.name,
        injected: row.injected,
        position: row.position,
        var_count,
        inherited,
    }
}

/// Own Bundles, plus any main-worktree Bundle whose name the Workspace does not
/// already have. Own entries win, which is what makes an override work.
fn merged_bundles(
    conn: &Connection,
    workspace_id: &str,
    inherit_from: Option<&str>,
) -> Result<Vec<BundleMeta>, AbundioError> {
    let own = bundles_of(conn, workspace_id)?;
    let own_names: HashSet<String> = own.iter().map(|b| b.name.clone()).collect();

    let mut out: Vec<BundleMeta> = Vec::new();
    for row in own {
        let count = var_count(conn, &row.id)?;
        out.push(to_meta(row, count, false));
    }

    if let Some(parent) = inherit_from {
        for row in bundles_of(conn, parent)? {
            if own_names.contains(&row.name) {
                continue;
            }
            let count = var_count(conn, &row.id)?;
            out.push(to_meta(row, count, true));
        }
    }

    // A Workspace with no Bundles at all still shows `default`, so the add form
    // has somewhere to write. It is materialised lazily on the first upsert.
    if out.is_empty() {
        out.push(BundleMeta {
            id: String::new(),
            workspace_id: workspace_id.to_string(),
            name: DEFAULT_BUNDLE.to_string(),
            injected: true,
            position: 0,
            var_count: 0,
            inherited: false,
        });
    }

    // At most one Bundle may read as injected — but zero is a legitimate state:
    // a Workspace whose injection was turned off carries no flag anywhere, and
    // must not have one invented for it. An own bundle wins over an inherited
    // one carrying the same flag — otherwise a Workspace that has overridden
    // its parent's injected bundle would show two bolts, and callers picking
    // "the injected one" by `find` would depend on ordering.
    let chosen = out
        .iter()
        .position(|b| b.injected && !b.inherited)
        .or_else(|| out.iter().position(|b| b.injected));
    for (i, b) in out.iter_mut().enumerate() {
        b.injected = Some(i) == chosen;
    }
    Ok(out)
}

/// Variables of one Bundle name: inherited first, then own (own wins by name).
fn merged_vars(
    conn: &Connection,
    workspace_id: &str,
    inherit_from: Option<&str>,
    bundle: &str,
    key: Option<&MasterKey>,
) -> Result<Vec<EnvVarMeta>, AbundioError> {
    let mut out: Vec<EnvVarMeta> = Vec::new();

    if let Some(parent) = inherit_from {
        for mut meta in vars_of(conn, parent, bundle, key)? {
            meta.inherited = true;
            out.push(meta);
        }
    }
    for meta in vars_of(conn, workspace_id, bundle, key)? {
        // An own variable replaces the inherited one of the same name.
        out.retain(|v| v.name != meta.name);
        out.push(meta);
    }
    Ok(out)
}

fn vars_of(
    conn: &Connection,
    workspace_id: &str,
    bundle: &str,
    key: Option<&MasterKey>,
) -> Result<Vec<EnvVarMeta>, AbundioError> {
    let Some(row) = find_bundle(conn, workspace_id, bundle)? else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT id, name, nonce, ciphertext, position, updated_at FROM workspace_env_vars
         WHERE bundle_id = ?1 ORDER BY position ASC, name ASC",
    )?;
    let rows = stmt
        .query_map(params![row.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Vec<u8>>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, i32>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows
        .into_iter()
        .map(|(id, name, nonce, ciphertext, position, updated_at)| {
            // With a key available, probe each row so the UI can mark
            // unreadable values. The plaintext is dropped immediately.
            let undecryptable = match key {
                Some(k) => env_crypto::open(k, &name, &nonce, &ciphertext).is_err(),
                None => true,
            };
            EnvVarMeta {
                id,
                bundle_id: row.id.clone(),
                byte_len: env_crypto::plaintext_len(ciphertext.len()),
                name,
                position,
                inherited: false,
                undecryptable,
                updated_at,
            }
        })
        .collect())
}

fn lookup_var(
    conn: &Connection,
    workspace_id: &str,
    bundle: &str,
    name: &str,
) -> Result<Option<(Vec<u8>, Vec<u8>)>, AbundioError> {
    let Some(row) = find_bundle(conn, workspace_id, bundle)? else {
        return Ok(None);
    };
    Ok(conn
        .query_row(
            "SELECT nonce, ciphertext FROM workspace_env_vars WHERE bundle_id = ?1 AND name = ?2",
            params![row.id, name],
            |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Vec<u8>>(1)?)),
        )
        .optional()?)
}

/// Resolve one Bundle to plaintext pairs, inherited first then own.
///
/// A row that fails to open is skipped and logged, never propagated: this runs
/// on the spawn path and on the helper path, and neither may be broken by one
/// bad row.
fn resolve_pairs(
    conn: &Connection,
    key: &MasterKey,
    workspace_id: &str,
    inherit_from: Option<&str>,
    bundle: &str,
) -> Result<Vec<(String, Zeroizing<String>)>, AbundioError> {
    let mut out: Vec<(String, Zeroizing<String>)> = Vec::new();
    let mut sources: Vec<&str> = Vec::new();
    if let Some(parent) = inherit_from {
        sources.push(parent);
    }
    sources.push(workspace_id);

    for source in sources {
        let Some(row) = find_bundle(conn, source, bundle)? else {
            continue;
        };
        let mut stmt = conn.prepare(
            "SELECT name, nonce, ciphertext FROM workspace_env_vars
             WHERE bundle_id = ?1 ORDER BY position ASC, name ASC",
        )?;
        let rows = stmt
            .query_map(params![row.id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        for (name, nonce, ciphertext) in rows {
            match env_crypto::open(key, &name, &nonce, &ciphertext) {
                Ok(plain) => match String::from_utf8(plain.to_vec()) {
                    Ok(value) => {
                        out.retain(|(existing, _)| existing != &name);
                        out.push((name, Zeroizing::new(value)));
                    }
                    Err(_) => log::warn!("[env] {name} is not valid UTF-8, skipping"),
                },
                Err(_) => log::warn!("[env] {name} could not be decrypted, skipping"),
            }
        }
    }
    Ok(out)
}

fn upsert_one(
    conn: &Connection,
    key: &MasterKey,
    workspace_id: &str,
    inherit_from: Option<&str>,
    bundle: &str,
    name: &str,
    value: &str,
) -> Result<EnvVarMeta, AbundioError> {
    env_crypto::validate_name(name)?;
    env_crypto::validate_value(value)?;

    // The Bundle may exist only on the main worktree; materialise an own copy
    // so this write becomes an override rather than failing.
    let row = match find_bundle(conn, workspace_id, bundle)? {
        Some(row) => row,
        None => create_own_bundle(conn, workspace_id, inherit_from, bundle)?,
    };

    let (nonce, ciphertext) = env_crypto::seal(key, name, value.as_bytes())?;
    let position: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM workspace_env_vars WHERE bundle_id = ?1",
            params![row.id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let new_id = Uuid::new_v4().to_string();

    conn.execute(
        "INSERT INTO workspace_env_vars (id, bundle_id, name, nonce, ciphertext, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(bundle_id, name) DO UPDATE SET
             nonce = excluded.nonce,
             ciphertext = excluded.ciphertext,
             updated_at = unixepoch()",
        params![new_id, row.id, name, nonce, ciphertext, position],
    )?;

    let (id, position, updated_at) = conn.query_row(
        "SELECT id, position, updated_at FROM workspace_env_vars
         WHERE bundle_id = ?1 AND name = ?2",
        params![row.id, name],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i32>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    )?;

    Ok(EnvVarMeta {
        id,
        bundle_id: row.id,
        name: name.to_string(),
        byte_len: value.len() as i64,
        position,
        inherited: false,
        undecryptable: false,
        updated_at,
    })
}

// ── Tauri commands ──

#[tauri::command]
pub fn env_list(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    bundle: Option<String>,
) -> Result<EnvListResult, AbundioError> {
    // A credential-store failure is soft here, unlike every other command: the
    // dialog must still be able to render variable names and offer Retry.
    let (key, key_error) = match env_crypto::master_key() {
        Ok(k) => (Some(k), None),
        Err(e) => (None, Some(e.to_string())),
    };
    let mut result = store.list(
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        bundle.as_deref(),
        key.as_ref(),
    )?;
    result.key_error = key_error;
    Ok(result)
}

#[tauri::command]
pub fn env_bundle_create(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    name: String,
) -> Result<BundleMeta, AbundioError> {
    store.create_bundle(
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &name,
    )
}

#[tauri::command]
pub fn env_bundle_rename(
    store: State<EnvVarStore>,
    workspace_id: String,
    from: String,
    to: String,
) -> Result<(), AbundioError> {
    store.rename_bundle(&workspace_id, &from, &to)
}

#[tauri::command]
pub fn env_bundle_set_injected(
    store: State<EnvVarStore>,
    workspace_id: String,
    name: String,
) -> Result<(), AbundioError> {
    store.set_injected(&workspace_id, &name)
}

/// Turn injection off for this Workspace — no Bundle is injected until one is
/// chosen again.
#[tauri::command]
pub fn env_bundle_clear_injected(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
) -> Result<(), AbundioError> {
    store.clear_injected(&workspace_id, inherit_from_workspace_id.as_deref())
}

/// Which Bundle new terminals in this Workspace receive, if any. Key-free, so
/// the status pill can poll it without a Keychain prompt.
#[tauri::command]
pub fn env_injected_summary(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
) -> Result<Option<InjectedSummary>, AbundioError> {
    store.injected_summary(&workspace_id, inherit_from_workspace_id.as_deref())
}

#[tauri::command]
pub fn env_bundle_delete(
    store: State<EnvVarStore>,
    workspace_id: String,
    name: String,
) -> Result<(), AbundioError> {
    store.delete_bundle(&workspace_id, &name)
}

#[tauri::command]
pub fn env_vars_upsert(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    bundle: String,
    name: String,
    value: String,
) -> Result<EnvVarMeta, AbundioError> {
    let key = env_crypto::master_key()?;
    store.upsert(
        &key,
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &bundle,
        &name,
        &value,
    )
}

#[tauri::command]
pub fn env_vars_upsert_many(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    bundle: String,
    entries: Vec<EnvVarInput>,
) -> Result<Vec<EnvVarMeta>, AbundioError> {
    let key = env_crypto::master_key()?;
    store.upsert_many(
        &key,
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &bundle,
        &entries,
    )
}

#[tauri::command]
pub fn env_vars_delete(
    store: State<EnvVarStore>,
    workspace_id: String,
    bundle: String,
    name: String,
) -> Result<(), AbundioError> {
    store.delete(&workspace_id, &bundle, &name)
}

#[tauri::command]
pub fn env_vars_reveal(
    store: State<EnvVarStore>,
    workspace_id: String,
    inherit_from_workspace_id: Option<String>,
    bundle: String,
    name: String,
) -> Result<String, AbundioError> {
    let key = env_crypto::master_key()?;
    store.reveal(
        &key,
        &workspace_id,
        inherit_from_workspace_id.as_deref(),
        &bundle,
        &name,
    )
}

#[tauri::command]
pub fn env_vars_reorder(
    store: State<EnvVarStore>,
    workspace_id: String,
    bundle: String,
    names: Vec<String>,
) -> Result<(), AbundioError> {
    store.reorder(&workspace_id, &bundle, &names)
}

/// Drop the cached master key and report whether the credential store can be
/// reached now. Backs the "Retry" button after a denied or locked keychain.
/// Process-global, so it affects every window — which is the right semantics
/// for "the keychain was just unlocked".
#[tauri::command]
pub fn env_retry_key() -> bool {
    env_crypto::invalidate_cache();
    env_crypto::master_key().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env_crypto::KEY_LEN;

    const WS: &str = "ws-1";
    const PARENT: &str = "ws-main";
    const PID: &str = "00000000-0000-0000-0000-000000000001";

    fn test_store() -> (EnvVarStore, MasterKey) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migrations::run_migrations(&conn).unwrap();
        for id in [WS, PARENT] {
            conn.execute(
                "INSERT INTO workspaces (id, name, root_folder, position, profile_id)
                 VALUES (?1, ?1, '/tmp', 0, ?2)",
                params![id, PID],
            )
            .unwrap();
        }
        (EnvVarStore::new(conn), MasterKey::from_bytes([3u8; KEY_LEN]))
    }

    #[test]
    fn first_upsert_creates_an_injected_default_bundle() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "TOKEN", "abc").unwrap();

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.bundles.len(), 1);
        assert_eq!(result.bundles[0].name, DEFAULT_BUNDLE);
        assert!(result.bundles[0].injected);
        assert_eq!(result.bundles[0].var_count, 1);
    }

    #[test]
    fn list_returns_names_and_sizes_but_never_values() {
        let (store, key) = test_store();
        store
            .upsert(&key, WS, None, DEFAULT_BUNDLE, "TOKEN", "supersecret")
            .unwrap();

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.vars.len(), 1);
        assert_eq!(result.vars[0].name, "TOKEN");
        assert_eq!(result.vars[0].byte_len, "supersecret".len() as i64);
        assert!(!result.vars[0].undecryptable);
        // The serialized payload must not carry the plaintext anywhere.
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("supersecret"), "list leaked a value: {json}");
    }

    #[test]
    fn upsert_replaces_value_and_preserves_position() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "B", "2").unwrap();
        let before = store.list(WS, None, None, Some(&key)).unwrap();
        let b_pos = before.vars.iter().find(|v| v.name == "B").unwrap().position;

        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "B", "22").unwrap();
        let after = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(after.vars.len(), 2);
        let b = after.vars.iter().find(|v| v.name == "B").unwrap();
        assert_eq!(b.position, b_pos, "position must survive an update");
        assert_eq!(
            store.reveal(&key, WS, None, DEFAULT_BUNDLE, "B").unwrap(),
            "22"
        );
    }

    #[test]
    fn reveal_round_trips_a_multiline_certificate() {
        let (store, key) = test_store();
        let pem = "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+g\n-----END CERTIFICATE-----\n";
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "CERT", pem).unwrap();
        assert_eq!(
            store.reveal(&key, WS, None, DEFAULT_BUNDLE, "CERT").unwrap(),
            pem
        );
    }

    #[test]
    fn reveal_unknown_name_is_not_found() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        assert!(matches!(
            store.reveal(&key, WS, None, DEFAULT_BUNDLE, "NOPE"),
            Err(AbundioError::NotFound(_))
        ));
    }

    #[test]
    fn bundles_are_independent() {
        let (store, key) = test_store();
        store.create_bundle(WS, None, "production").unwrap();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "URL", "dev").unwrap();
        store.upsert(&key, WS, None, "production", "URL", "prod").unwrap();

        assert_eq!(
            store.reveal(&key, WS, None, DEFAULT_BUNDLE, "URL").unwrap(),
            "dev"
        );
        assert_eq!(
            store.reveal(&key, WS, None, "production", "URL").unwrap(),
            "prod"
        );
    }

    #[test]
    fn only_the_injected_bundle_is_resolved_for_spawn() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "DEV", "1").unwrap();
        store.upsert(&key, WS, None, "production", "PROD", "2").unwrap();

        let pairs = store.resolve_for_spawn(&key, WS, None).unwrap();
        let names: Vec<_> = pairs.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["DEV"], "on-demand bundles must not be injected");
    }

    #[test]
    fn set_injected_moves_the_flag() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "DEV", "1").unwrap();
        store.upsert(&key, WS, None, "production", "PROD", "2").unwrap();

        store.set_injected(WS, "production").unwrap();
        let pairs = store.resolve_for_spawn(&key, WS, None).unwrap();
        let names: Vec<_> = pairs.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["PROD"]);

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.bundles.iter().filter(|b| b.injected).count(), 1);
    }

    #[test]
    fn clear_injected_leaves_nothing_injected() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "DEV", "1").unwrap();

        store.clear_injected(WS, None).unwrap();

        assert!(store.resolve_for_spawn(&key, WS, None).unwrap().is_empty());
        assert!(!store.has_injected_vars(WS, None).unwrap());
        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.bundles.iter().filter(|b| b.injected).count(), 0);
        // The Bundle itself survives — it is still readable on demand.
        assert_eq!(result.bundles.len(), 1);
        assert_eq!(
            store.resolve_bundle(&key, WS, None, DEFAULT_BUNDLE).unwrap().len(),
            1
        );
    }

    #[test]
    fn clear_injected_on_a_worktree_beats_inheritance() {
        let (store, key) = test_store();
        store.upsert(&key, PARENT, None, DEFAULT_BUNDLE, "DEV", "1").unwrap();
        // The worktree inherits the parent's injected Bundle to start with.
        assert_eq!(store.resolve_for_spawn(&key, WS, Some(PARENT)).unwrap().len(), 1);

        store.clear_injected(WS, Some(PARENT)).unwrap();

        assert!(store
            .resolve_for_spawn(&key, WS, Some(PARENT))
            .unwrap()
            .is_empty());
        assert!(!store.has_injected_vars(WS, Some(PARENT)).unwrap());
        // The parent is untouched.
        assert_eq!(store.resolve_for_spawn(&key, PARENT, None).unwrap().len(), 1);
        // Values still resolve through inheritance, on demand.
        assert_eq!(
            store.resolve_bundle(&key, WS, Some(PARENT), DEFAULT_BUNDLE).unwrap().len(),
            1
        );
    }

    // The list shows a placeholder `default` as injected before any variable
    // exists. Turning that off must stick rather than flipping straight back.
    #[test]
    fn clear_injected_sticks_for_a_workspace_with_no_bundles_yet() {
        let (store, key) = test_store();

        store.clear_injected(WS, None).unwrap();

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.bundles.iter().filter(|b| b.injected).count(), 0);
        // ...and the materialised row can be injected again.
        store.set_injected(WS, DEFAULT_BUNDLE).unwrap();
        let after = store.list(WS, None, None, Some(&key)).unwrap();
        assert!(after.bundles.iter().any(|b| b.injected));
    }

    #[test]
    fn budget_is_zero_when_nothing_is_injected() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        store.upsert(&key, WS, None, "production", "B", "2").unwrap();
        store.clear_injected(WS, None).unwrap();

        // Selecting an on-demand bundle must not measure `default` against the
        // budget — nothing is going into any environment block.
        let result = store.list(WS, None, Some("production"), Some(&key)).unwrap();
        assert_eq!(result.bytes_used, 0);
    }

    #[test]
    fn set_injected_restores_injection_after_clearing() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "DEV", "1").unwrap();
        store.clear_injected(WS, None).unwrap();

        store.set_injected(WS, DEFAULT_BUNDLE).unwrap();

        let pairs = store.resolve_for_spawn(&key, WS, None).unwrap();
        assert_eq!(pairs.len(), 1);
    }

    #[test]
    fn injected_summary_reports_the_bundle_and_count() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "B", "2").unwrap();

        let summary = store.injected_summary(WS, None).unwrap().unwrap();
        assert_eq!(summary.bundle, DEFAULT_BUNDLE);
        assert_eq!(summary.var_count, 2);
        assert!(!summary.inherited);

        store.clear_injected(WS, None).unwrap();
        assert!(store.injected_summary(WS, None).unwrap().is_none());
    }

    #[test]
    fn injected_summary_counts_inherited_variables() {
        let (store, key) = test_store();
        store.upsert(&key, PARENT, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        store.upsert(&key, PARENT, None, DEFAULT_BUNDLE, "B", "2").unwrap();
        // An override of one name must not double-count it.
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "B", "own").unwrap();

        let summary = store.injected_summary(WS, Some(PARENT)).unwrap().unwrap();
        assert_eq!(summary.var_count, 2);
    }

    #[test]
    fn resolve_bundle_reads_on_demand_bundles() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, "production", "PROD", "2").unwrap();
        let pairs = store.resolve_bundle(&key, WS, None, "production").unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0, "PROD");
        assert_eq!(pairs[0].1.as_str(), "2");
    }

    #[test]
    fn resolve_unknown_bundle_is_not_found() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        assert!(matches!(
            store.resolve_bundle(&key, WS, None, "nope"),
            Err(AbundioError::NotFound(_))
        ));
    }

    // ── Inheritance ──

    #[test]
    fn linked_worktree_inherits_parent_bundles_and_vars() {
        let (store, key) = test_store();
        store
            .upsert(&key, PARENT, None, DEFAULT_BUNDLE, "SHARED", "from-parent")
            .unwrap();
        store.upsert(&key, PARENT, None, "production", "PROD", "p").unwrap();

        let result = store.list(WS, Some(PARENT), None, Some(&key)).unwrap();
        let names: Vec<_> = result.bundles.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&DEFAULT_BUNDLE));
        assert!(names.contains(&"production"));
        assert!(result.bundles.iter().all(|b| b.inherited));

        assert_eq!(result.vars.len(), 1);
        assert_eq!(result.vars[0].name, "SHARED");
        assert!(result.vars[0].inherited);
    }

    #[test]
    fn own_variable_overrides_inherited_one() {
        let (store, key) = test_store();
        store
            .upsert(&key, PARENT, None, DEFAULT_BUNDLE, "URL", "parent")
            .unwrap();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "URL", "child").unwrap();

        let result = store.list(WS, Some(PARENT), None, Some(&key)).unwrap();
        assert_eq!(result.vars.len(), 1, "override must not duplicate the row");
        assert!(!result.vars[0].inherited);

        let pairs = store.resolve_for_spawn(&key, WS, Some(PARENT)).unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].1.as_str(), "child");
    }

    /// Regression: overriding a variable from a linked worktree used to
    /// materialise a local `default` bundle marked injected, which then shadowed
    /// the inherited injected bundle and left the worktree with NO variables.
    #[test]
    fn overriding_from_a_worktree_keeps_the_inherited_bundle_injected() {
        let (store, key) = test_store();
        // The parent's injected bundle is deliberately NOT called "default".
        store.upsert(&key, PARENT, None, "production", "A", "parent").unwrap();
        store.set_injected(PARENT, "production").unwrap();

        // Before the override the worktree sees the parent's variables.
        let before = store.resolve_for_spawn(&key, WS, Some(PARENT)).unwrap();
        assert_eq!(before.len(), 1);

        // Overriding one variable must not silently empty the environment.
        store.upsert(&key, WS, None, "production", "A", "child").unwrap();

        let after = store.resolve_for_spawn(&key, WS, Some(PARENT)).unwrap();
        let names: Vec<_> = after.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["A"], "worktree lost its environment");
        assert_eq!(after[0].1.as_str(), "child");

        let listed = store.list(WS, Some(PARENT), None, Some(&key)).unwrap();
        assert_eq!(
            listed.bundles.iter().filter(|b| b.injected).count(),
            1,
            "exactly one bundle may read as injected"
        );
        assert_eq!(
            listed.bundles.iter().find(|b| b.injected).unwrap().name,
            "production"
        );
    }

    #[test]
    fn resolve_orders_inherited_before_own() {
        let (store, key) = test_store();
        store.upsert(&key, PARENT, None, DEFAULT_BUNDLE, "P", "1").unwrap();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "C", "2").unwrap();

        let pairs = store.resolve_for_spawn(&key, WS, Some(PARENT)).unwrap();
        let names: Vec<_> = pairs.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["P", "C"]);
    }

    #[test]
    fn reveal_falls_back_to_the_inherited_value() {
        let (store, key) = test_store();
        store
            .upsert(&key, PARENT, None, DEFAULT_BUNDLE, "ONLY_PARENT", "p")
            .unwrap();
        assert_eq!(
            store
                .reveal(&key, WS, Some(PARENT), DEFAULT_BUNDLE, "ONLY_PARENT")
                .unwrap(),
            "p"
        );
    }

    /// Editing an inherited value writes an own Bundle + row rather than
    /// mutating the parent's.
    #[test]
    fn overriding_an_inherited_bundle_creates_an_own_copy() {
        let (store, key) = test_store();
        store
            .upsert(&key, PARENT, None, "production", "URL", "parent")
            .unwrap();
        store.upsert(&key, WS, None, "production", "URL", "child").unwrap();

        assert_eq!(
            store.reveal(&key, PARENT, None, "production", "URL").unwrap(),
            "parent",
            "the parent's value must be untouched"
        );
        assert_eq!(
            store.reveal(&key, WS, None, "production", "URL").unwrap(),
            "child"
        );
    }

    // ── Failure modes ──

    #[test]
    fn undecryptable_rows_are_flagged_and_skipped_not_fatal() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "GOOD", "ok").unwrap();
        // Simulate a database restored onto a machine without the key.
        {
            let conn = store.conn.lock().unwrap();
            let bundle_id: String = conn
                .query_row(
                    "SELECT id FROM workspace_env_bundles WHERE workspace_id = ?1",
                    params![WS],
                    |r| r.get(0),
                )
                .unwrap();
            conn.execute(
                "INSERT INTO workspace_env_vars (id, bundle_id, name, nonce, ciphertext)
                 VALUES ('bad', ?1, 'BAD', X'000102030405060708090a0b',
                         X'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')",
                params![bundle_id],
            )
            .unwrap();
        }

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        let bad = result.vars.iter().find(|v| v.name == "BAD").unwrap();
        assert!(bad.undecryptable);
        let good = result.vars.iter().find(|v| v.name == "GOOD").unwrap();
        assert!(!good.undecryptable);

        // Spawn resolution must survive the bad row.
        let pairs = store.resolve_for_spawn(&key, WS, None).unwrap();
        let names: Vec<_> = pairs.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["GOOD"]);
    }

    #[test]
    fn upsert_rejects_invalid_and_reserved_names() {
        let (store, key) = test_store();
        for bad in ["1FOO", "FOO-BAR", "ABUNDIO_PTY_ID", "ZDOTDIR", ""] {
            assert!(
                store.upsert(&key, WS, None, DEFAULT_BUNDLE, bad, "x").is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn upsert_rejects_oversize_value() {
        let (store, key) = test_store();
        let huge = "x".repeat(env_crypto::MAX_VALUE_BYTES + 1);
        assert!(store.upsert(&key, WS, None, DEFAULT_BUNDLE, "BIG", &huge).is_err());
    }

    #[test]
    fn upsert_many_is_atomic() {
        let (store, key) = test_store();
        let entries = vec![
            EnvVarInput {
                name: "OK1".into(),
                value: "1".into(),
            },
            EnvVarInput {
                name: "1BAD".into(),
                value: "2".into(),
            },
            EnvVarInput {
                name: "OK2".into(),
                value: "3".into(),
            },
        ];
        assert!(store.upsert_many(&key, WS, None, DEFAULT_BUNDLE, &entries).is_err());

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.vars.len(), 0, "a failed import must write nothing");
    }

    #[test]
    fn upsert_many_writes_all_on_success() {
        let (store, key) = test_store();
        let entries = vec![
            EnvVarInput {
                name: "A".into(),
                value: "1".into(),
            },
            EnvVarInput {
                name: "B".into(),
                value: "2".into(),
            },
        ];
        store.upsert_many(&key, WS, None, DEFAULT_BUNDLE, &entries).unwrap();
        assert_eq!(store.list(WS, None, None, Some(&key)).unwrap().vars.len(), 2);
    }

    // ── Bundle lifecycle ──

    #[test]
    fn cannot_delete_the_last_bundle() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        assert!(matches!(
            store.delete_bundle(WS, DEFAULT_BUNDLE),
            Err(AbundioError::InvalidOperation(_))
        ));
    }

    #[test]
    fn deleting_the_injected_bundle_promotes_another() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        store.upsert(&key, WS, None, "production", "B", "2").unwrap();

        store.delete_bundle(WS, DEFAULT_BUNDLE).unwrap();
        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.bundles.len(), 1);
        assert_eq!(result.bundles[0].name, "production");
        assert!(
            result.bundles[0].injected,
            "a workspace must always have an injected bundle"
        );
    }

    #[test]
    fn deleting_a_bundle_removes_its_variables() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        store.upsert(&key, WS, None, "production", "B", "2").unwrap();
        store.delete_bundle(WS, "production").unwrap();

        let conn = store.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_env_vars", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn create_bundle_rejects_duplicates_and_bad_names() {
        let (store, _key) = test_store();
        store.create_bundle(WS, None, "production").unwrap();
        assert!(store.create_bundle(WS, None, "production").is_err());
        assert!(store.create_bundle(WS, None, "has space").is_err());
        assert!(store.create_bundle(WS, None, "").is_err());
    }

    #[test]
    fn rename_bundle_moves_variables_with_it() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, "staging", "A", "1").unwrap();
        store.rename_bundle(WS, "staging", "preprod").unwrap();

        assert_eq!(store.reveal(&key, WS, None, "preprod", "A").unwrap(), "1");
        assert!(store.resolve_bundle(&key, WS, None, "staging").is_err());
    }

    #[test]
    fn rename_bundle_rejects_a_name_already_in_use() {
        let (store, _key) = test_store();
        store.create_bundle(WS, None, "a").unwrap();
        store.create_bundle(WS, None, "b").unwrap();
        assert!(store.rename_bundle(WS, "a", "b").is_err());
    }

    #[test]
    fn delete_removes_only_the_named_variable() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "B", "2").unwrap();
        store.delete(WS, DEFAULT_BUNDLE, "A").unwrap();

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.vars.len(), 1);
        assert_eq!(result.vars[0].name, "B");
    }

    #[test]
    fn reorder_sets_positions_in_the_given_order() {
        let (store, key) = test_store();
        for name in ["A", "B", "C"] {
            store.upsert(&key, WS, None, DEFAULT_BUNDLE, name, "x").unwrap();
        }
        store
            .reorder(
                WS,
                DEFAULT_BUNDLE,
                &["C".to_string(), "B".to_string(), "A".to_string()],
            )
            .unwrap();

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        let names: Vec<_> = result.vars.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, vec!["C", "B", "A"]);
    }

    #[test]
    fn bytes_used_reflects_the_injected_bundle_only() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "12345").unwrap();
        store
            .upsert(&key, WS, None, "production", "B", &"x".repeat(1000))
            .unwrap();

        let result = store.list(WS, None, None, Some(&key)).unwrap();
        // Reported in the SAME units the spawn path spends, so the add form
        // cannot accept a variable that `build_env_injection` would then drop.
        assert_eq!(result.bytes_used, env_crypto::injection_cost(1, 5) as i64);
        assert_eq!(result.bytes_budget, env_crypto::MAX_INJECTED_BYTES as i64);
    }

    #[test]
    fn empty_workspace_lists_a_virtual_default_bundle() {
        let (store, key) = test_store();
        let result = store.list(WS, None, None, Some(&key)).unwrap();
        assert_eq!(result.bundles.len(), 1);
        assert_eq!(result.bundles[0].name, DEFAULT_BUNDLE);
        assert!(result.bundles[0].injected);
        assert_eq!(result.selected_bundle, DEFAULT_BUNDLE);
        assert!(result.vars.is_empty());
    }

    #[test]
    fn bundle_names_include_inherited_ones() {
        let (store, key) = test_store();
        store.upsert(&key, PARENT, None, "production", "A", "1").unwrap();
        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "B", "2").unwrap();

        let mut names = store.bundle_names(WS, Some(PARENT)).unwrap();
        names.sort();
        assert_eq!(names, vec!["default", "production"]);
    }

    /// Guards the credential-store short circuit: a Workspace with nothing to
    /// inject must be answerable WITHOUT a key, or opening the very first
    /// terminal would prompt for Keychain access and mint a key the user never
    /// asked for.
    #[test]
    fn has_injected_vars_answers_without_a_key() {
        let (store, key) = test_store();
        assert!(!store.has_injected_vars(WS, None).unwrap());
        assert!(!store.has_injected_vars(WS, Some(PARENT)).unwrap());

        store.upsert(&key, WS, None, DEFAULT_BUNDLE, "A", "1").unwrap();
        assert!(store.has_injected_vars(WS, None).unwrap());
    }

    /// An on-demand bundle is not injected, so it must not drag the credential
    /// store into the spawn path either.
    #[test]
    fn has_injected_vars_ignores_on_demand_bundles() {
        let (store, key) = test_store();
        store.upsert(&key, WS, None, "production", "A", "1").unwrap();
        store.create_bundle(WS, None, "other").unwrap();
        store.set_injected(WS, "other").unwrap();
        assert!(
            !store.has_injected_vars(WS, None).unwrap(),
            "only the injected bundle's contents count"
        );
    }

    #[test]
    fn has_injected_vars_sees_inherited_rows() {
        let (store, key) = test_store();
        store
            .upsert(&key, PARENT, None, DEFAULT_BUNDLE, "A", "1")
            .unwrap();
        assert!(store.has_injected_vars(WS, Some(PARENT)).unwrap());
    }

    #[test]
    fn resolve_for_spawn_is_empty_for_a_workspace_with_nothing() {
        let (store, key) = test_store();
        assert!(store.resolve_for_spawn(&key, WS, None).unwrap().is_empty());
    }
}
