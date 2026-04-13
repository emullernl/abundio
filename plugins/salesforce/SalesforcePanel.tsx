import { useEffect, useState } from "react";
import { salesforce as sfIpc } from "../../src/lib/ipc";
import type { SalesforceOrg } from "../../src/lib/types";

export default function SalesforcePanel() {
const [orgs, setOrgs] = useState<SalesforceOrg[]>([]);
const [loading, setLoading] = useState(false);
const [error, setError] = useState<string | null>(null);

useEffect(() => {
loadOrgs();
}, []);

const loadOrgs = async () => {
setLoading(true);
setError(null);
try {
const loadedOrgs = await sfIpc.orgList();
setOrgs(loadedOrgs);
} catch (err) {
setError(err instanceof Error ? err.message : "Failed to load orgs");
} finally {
setLoading(false);
}
};

const handleSetDefault = async (orgId: string) => {
try {
await sfIpc.setDefaultOrg(orgId);
loadOrgs();
} catch (err) {
setError(err instanceof Error ? err.message : "Failed to set default org");
}
};

const handleOpenOrg = async (orgId: string) => {
try {
await sfIpc.openOrg(orgId);
} catch (err) {
setError(err instanceof Error ? err.message : "Failed to open org");
}
};

const handleDeploy = async (sourcePath: string, orgId: string) => {
try {
const result = await sfIpc.deploy(sourcePath, orgId);
alert(`Deploy successful: ${result}`);
} catch (err) {
setError(err instanceof Error ? err.message : "Deploy failed");
}
};

return (
<div className="flex flex-col gap-4 flex-1 min-h-0">
<div className="flex items-center justify-between">
<h3 className="font-semibold" style={{ color: "var(--fg-primary)" }}>
Salesforce Orgs
</h3>
<button
type="button"
onClick={loadOrgs}
disabled={loading}
className="px-3 py-1 rounded text-sm"
style={{
backgroundColor: "var(--bg-tertiary)",
color: "var(--fg-primary)",
border: "1px solid var(--border)",
}}
>
{loading ? "Loading..." : "Refresh"}
</button>
</div>

{error && (
<div
className="p-3 rounded"
style={{
backgroundColor: "color-mix(in srgb, var(--error) 10%, transparent)",
border: "1px solid var(--error)",
color: "var(--error)",
}}
>
{error}
</div>
)}

<div className="flex-1 min-h-0 overflow-y-auto">
{orgs.length === 0 && !loading && (
<p style={{ color: "var(--fg-secondary)" }}>No orgs found</p>
)}
<div className="flex flex-col gap-2">
{orgs.map((org) => (
<div
key={org.orgId}
className="p-3 rounded"
style={{
backgroundColor: "var(--bg-secondary)",
border: "1px solid var(--border)",
}}
>
<div className="flex items-center justify-between mb-2">
<div>
<div
className="font-medium"
style={{ color: "var(--fg-primary)" }}
>
{org.alias || org.username}
</div>
<div
className="text-sm"
style={{ color: "var(--fg-secondary)" }}
>
{org.instanceUrl}
</div>
</div>
{org.isDefault && (
<span
className="px-2 py-1 rounded text-xs"
style={{
backgroundColor: "var(--accent)",
color: "var(--bg-primary)",
}}
>
Default
</span>
)}
</div>
<div className="flex gap-2">
<button
type="button"
onClick={() => handleSetDefault(org.orgId)}
className="px-3 py-1 rounded text-sm"
style={{
backgroundColor: "var(--bg-tertiary)",
color: "var(--fg-primary)",
}}
>
Set Default
</button>
<button
type="button"
onClick={() => handleOpenOrg(org.orgId)}
className="px-3 py-1 rounded text-sm"
style={{
backgroundColor: "var(--bg-tertiary)",
color: "var(--fg-primary)",
}}
>
Open
</button>
<button
type="button"
onClick={() => handleDeploy(".", org.orgId)}
className="px-3 py-1 rounded text-sm"
style={{
backgroundColor: "var(--accent)",
color: "var(--bg-primary)",
}}
>
Deploy
</button>
</div>
</div>
))}
</div>
</div>
</div>
);
}
