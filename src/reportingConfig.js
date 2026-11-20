// Remote error reporting is DISABLED in this fork.
// The original project sent opt-in reports to its own Cloudflare Worker.
// Leave this empty unless you deploy your own Worker; when empty, reports stay
// local (see logs.html / pending.html) and the "send report" control is hidden.
// If you set an origin here you must also add it to optional_host_permissions
// in manifest.json and describe it in privacy.html and the store listing.
globalThis.REPORTING_ORIGIN = '';
