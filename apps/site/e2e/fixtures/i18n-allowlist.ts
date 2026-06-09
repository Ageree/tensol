// Words that are valid i18n key names AND appear as real rendered content.
// Each entry was verified by running i18n.spec.ts and triaging which key matches were false positives.
export const KNOWN_NATURAL_WORDS: ReadonlySet<string> = new Set([
	"data", // appears in legal/contact body text ("your data", "data processing")
	"privacy", // appears in legal pages ("privacy policy", "privacy")
	"contact", // appears in footer nav and legal ("contact us")
	"submit", // appears as button label text on forms
	"view", // appears as link text ("view details")
	"terms", // appears in legal pages ("terms of service")
	"trust", // appears in marketing nav ("Trust") and as a route name
	"scope", // appears in marketing copy ("scope")
	"live", // appears in marketing copy and nav ("live")
	"steps", // appears in marketing pipeline section
	"nav", // internal key name; short
	"en", // locale code, appears in LangSwitcher
	"ru", // locale code, appears in LangSwitcher
	"legal", // appears in footer nav link text ("Legal")
	"dpa", // appears in legal pages ("DPA")
	"compliance", // appears in /trust compliance grid section headings
	"authz", // appears in /approval page authorization labels
	"open", // appears in /live live-event stream ("open", "open issue")
	"back", // appears as navigation button label ("← Back") on multiple routes
	"next", // appears as pagination/stepper label ("Next →") on /trust, /live, /findings
	"copy", // appears as action label ("Copy") on /legal/terms and /legal/dpa
]);
