// T106 — Deep-inquiry intake form (US2 lead-gen funnel).
//
// Hybrid form:
//   - Anonymous by default.
//   - If `GET /api/auth/me` returns a session, prefill `email`.
//
// Wire contract:
//   - POST /v1/deep-inquiries (server/src/schemas/deep-inquiries.ts
//     CreateInquiryBodySchema).
//   - 201 → navigate('/deep-inquiry/thank-you')
//   - 422 → field-level errors (parse `details: [{path, ...}]`)
//   - other → generic error banner
//
// Constitution VII: ≤ 800 LOC. Constitution IX: client validates loosely,
// the server-side Zod (CreateInquiryBodySchema) is the canonical source of
// truth; we mirror the same lengths/shapes here only as UX hints.

import {
	type FormEvent,
	type ReactElement,
	useEffect,
	useMemo,
	useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { LangSwitcher } from "../components/LangSwitcher.tsx";
import { AuthWave } from "../components/PixelWaveBg.tsx";
import { RouteHead } from "../components/RouteHead.tsx";
import {
	Checkbox,
	Field,
	HalftoneBg,
	Input,
	Mono,
	Select,
	Textarea,
} from "../components/primitives.tsx";
import { useTensol } from "../context.tsx";
import {
	ApiError,
	type CreateDeepInquiryBody,
	type DeepInquiryBudgetBand,
	auth,
	deepInquiries,
} from "../lib/api-client.ts";

/* ─────────────────────────────────────────────────────────────────────
   Form state
   ───────────────────────────────────────────────────────────────────── */

type SubmitState = "idle" | "submitting" | "error";

interface FormShape {
	company: string;
	contact_name: string;
	position: string;
	email: string;
	phone: string;
	domains_text: string;
	scope_text: string;
	budget_band: "" | DeepInquiryBudgetBand;
	desired_date: string; // yyyy-mm-dd, normalised to unix at submit
	consent: boolean;
}

type FieldErrors = Partial<Record<keyof FormShape, string>>;

const EMPTY_FORM: FormShape = {
	company: "",
	contact_name: "",
	position: "",
	email: "",
	phone: "",
	domains_text: "",
	scope_text: "",
	budget_band: "",
	desired_date: "",
	consent: false,
};

/* ─────────────────────────────────────────────────────────────────────
   Loose client-side validation. Server (Zod) is the source of truth.
   ───────────────────────────────────────────────────────────────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_DIGITS_RE = /\d/g;
const TELEGRAM_HANDLE_RE = /^[A-Za-z0-9_]{4,32}$/;

export function isValidEmail(value: string): boolean {
	if (!value) return false;
	return EMAIL_RE.test(value.trim());
}

/**
 * Phone OR Telegram @handle — per data-model E6 the `phone` column accepts
 * either an E.164 number or a Telegram `@handle`. Loose check here; server
 * is canonical.
 */
export function isValidPhoneOrHandle(raw: string): boolean {
	const v = raw.trim();
	if (!v) return false;
	if (v.startsWith("@")) return TELEGRAM_HANDLE_RE.test(v.slice(1));
	const digits = (v.match(PHONE_DIGITS_RE) ?? []).length;
	return digits >= 10 && digits <= 15;
}

/* ─────────────────────────────────────────────────────────────────────
   Build the wire body from form state, dropping empty optionals so the
   server schema's `.optional()` shapes accept the request.
   ───────────────────────────────────────────────────────────────────── */

function buildBody(form: FormShape): CreateDeepInquiryBody {
	const body: CreateDeepInquiryBody = {
		company: form.company.trim(),
		contact_name: form.contact_name.trim(),
		phone: form.phone.trim(),
		domains_text: form.domains_text.trim(),
		scope_text: form.scope_text.trim(),
		consent_accepted: true,
	};
	const position = form.position.trim();
	if (position) body.position = position;
	const email = form.email.trim();
	if (email) body.email = email;
	if (form.budget_band) body.budget_band = form.budget_band;
	if (form.desired_date) {
		const ts = Math.floor(new Date(form.desired_date).getTime() / 1000);
		if (!Number.isNaN(ts)) body.desired_date = ts;
	}
	return body;
}

/* ─────────────────────────────────────────────────────────────────────
   Map server validation `details: [{path, ...}]` to field errors.
   Tolerant of both `path` (Zod-style) and `field` shapes.
   ───────────────────────────────────────────────────────────────────── */

const PATH_TO_FIELD: Record<string, keyof FormShape> = {
	company: "company",
	contact_name: "contact_name",
	position: "position",
	email: "email",
	phone: "phone",
	domains_text: "domains_text",
	scope_text: "scope_text",
	budget_band: "budget_band",
	desired_date: "desired_date",
	consent_accepted: "consent",
};

function mapServerValidationDetails(
	details: unknown,
	fallback: string,
): FieldErrors {
	if (!Array.isArray(details)) return {};
	const out: FieldErrors = {};
	for (const raw of details) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const candidate =
			(typeof item.path === "string" && item.path) ||
			(Array.isArray(item.path) &&
				typeof item.path[0] === "string" &&
				item.path[0]) ||
			(typeof item.field === "string" && item.field) ||
			"";
		const field = PATH_TO_FIELD[candidate];
		if (!field) continue;
		const msg = (typeof item.message === "string" && item.message) || fallback;
		out[field] = msg;
	}
	return out;
}

/* ─────────────────────────────────────────────────────────────────────
   Component
   ───────────────────────────────────────────────────────────────────── */

export default function DeepInquiry(): ReactElement {
	const { t } = useTensol();
	const navigate = useNavigate();

	const [form, setForm] = useState<FormShape>(EMPTY_FORM);
	const [errors, setErrors] = useState<FieldErrors>({});
	const [submitState, setSubmitState] = useState<SubmitState>("idle");
	const [genericError, setGenericError] = useState<string | null>(null);

	// Best-effort prefill from /api/auth/me. Anonymous users silently get null
	// (the auth client maps 401 → null). Any other failure is non-fatal.
	useEffect(() => {
		let cancelled = false;
		auth
			.me()
			.then((me) => {
				if (cancelled || !me) return;
				setForm((prev) => (prev.email ? prev : { ...prev, email: me.email }));
			})
			.catch(() => {
				/* non-fatal — form stays anonymous */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const update = <K extends keyof FormShape>(
		key: K,
		value: FormShape[K],
	): void => {
		setForm((prev) => ({ ...prev, [key]: value }));
		if (errors[key]) {
			setErrors((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		}
	};

	const budgetOptions = useMemo(
		() => [
			{ value: "", label: "—" },
			{ value: "open", label: t.deepInquiry.budgetOptions.open },
			{ value: "under_500k", label: t.deepInquiry.budgetOptions.under_500k },
			{ value: "500k_1m", label: t.deepInquiry.budgetOptions.band_500k_1m },
			{ value: "1m_3m", label: t.deepInquiry.budgetOptions.band_1m_3m },
			{ value: "3m_plus", label: t.deepInquiry.budgetOptions.band_3m_plus },
		],
		[t],
	);

	/* ───── Client-side validation ───── */
	const validate = (): FieldErrors => {
		const e: FieldErrors = {};
		const req = t.deepInquiry.errors.required;
		if (!form.company.trim()) e.company = req;
		if (!form.contact_name.trim()) e.contact_name = req;
		if (!form.phone.trim()) e.phone = req;
		else if (!isValidPhoneOrHandle(form.phone))
			e.phone = t.deepInquiry.errors.invalidPhone;
		if (form.email.trim() && !isValidEmail(form.email))
			e.email = t.deepInquiry.errors.invalidEmail;
		if (!form.domains_text.trim()) e.domains_text = req;
		else if (form.domains_text.length > 10_000)
			e.domains_text = t.deepInquiry.errors.domainsTooLong;
		if (!form.scope_text.trim()) e.scope_text = req;
		else if (form.scope_text.length > 10_000)
			e.scope_text = t.deepInquiry.errors.scopeTooLong;
		if (!form.consent) e.consent = t.deepInquiry.errors.consent;
		return e;
	};

	const onSubmit = async (ev: FormEvent<HTMLFormElement>): Promise<void> => {
		ev.preventDefault();
		setGenericError(null);

		const localErrors = validate();
		if (Object.keys(localErrors).length > 0) {
			setErrors(localErrors);
			return;
		}
		setErrors({});
		setSubmitState("submitting");

		try {
			await deepInquiries.create(buildBody(form));
			navigate("/deep-inquiry/thank-you");
		} catch (err) {
			setSubmitState("error");
			if (err instanceof ApiError && err.status === 422 && err.details) {
				const fieldErrs = mapServerValidationDetails(
					err.details,
					t.deepInquiry.errors.required,
				);
				if (Object.keys(fieldErrs).length > 0) {
					setErrors(fieldErrs);
					return;
				}
			}
			setGenericError(
				(err instanceof ApiError && err.message) ||
					t.deepInquiry.errors.generic,
			);
		}
	};

	/* ───── Layout ───── */
	return (
		<>
			<RouteHead
				title="Whitebox assessment — Sthrip"
				description="Book a source-backed AI security assessment for applications, APIs, repositories, and critical business flows."
				ogTitle="Whitebox assessment — Sthrip"
				ogDescription="Book a source-backed AI security assessment for applications, APIs, repositories, and critical business flows."
				ogImage="/assets/sthrip-noise-field.jpg"
			/>
			<div
				style={{
					minHeight: "100vh",
					background: "var(--paper)",
					color: "var(--ink)",
					display: "grid",
					gridTemplateColumns: "1.1fr 1fr",
				}}
			>
				{/* Left: ink-aside with halftone + wave */}
				<aside
					style={{
						position: "relative",
						overflow: "hidden",
						background: "var(--ink)",
						color: "var(--paper)",
						padding: "40px 48px",
						display: "flex",
						flexDirection: "column",
						justifyContent: "space-between",
					}}
				>
					<HalftoneBg color="var(--paper)" opacity={0.08} />
					<AuthWave />

					<div style={{ position: "relative" }}>
						<button
							type="button"
							onClick={() => navigate("/")}
							style={{
								background: "transparent",
								border: "none",
								color: "var(--paper)",
								cursor: "pointer",
								padding: 0,
								display: "inline-flex",
								alignItems: "center",
								gap: 10,
							}}
						>
							<img
								src="/assets/sthrip-wordmark-white.png"
								alt="STHRIP"
								style={{
									display: "block",
									width: 126,
									height: "auto",
									imageRendering: "pixelated",
								}}
							/>
						</button>
					</div>

					<div style={{ position: "relative", maxWidth: 420 }}>
						<Mono size={11} color="rgba(255,255,255,.6)">
							WHITEBOX ASSESSMENT
						</Mono>
						<p
							style={{
								fontFamily: "'Inter', sans-serif",
								fontSize: 15,
								lineHeight: 1.55,
								color: "rgba(255,255,255,.85)",
								margin: "16px 0 0",
							}}
						>
							{t.deepInquiry.lead}
						</p>
					</div>
				</aside>

				{/* Right: paper form panel */}
				<main
					style={{
						position: "relative",
						display: "flex",
						alignItems: "flex-start",
						justifyContent: "center",
						padding: "40px",
						overflowY: "auto",
					}}
				>
					<div style={{ position: "absolute", top: 32, right: 40 }}>
						<LangSwitcher />
					</div>

					<div style={{ width: "100%", maxWidth: 560, marginTop: 24 }}>
						<h1
							style={{
								fontFamily: "'Space Grotesk', sans-serif",
								fontWeight: 500,
								fontSize: 40,
								lineHeight: 1.05,
								letterSpacing: "-0.02em",
								margin: "0 0 28px",
							}}
						>
							{t.deepInquiry.title}
						</h1>

						<form
							onSubmit={onSubmit}
							noValidate
							data-screen-label="deep-inquiry"
							style={{ display: "flex", flexDirection: "column", gap: 16 }}
						>
							<Field label={t.deepInquiry.fCompany} error={errors.company}>
								<Input
									value={form.company}
									onChange={(e) => update("company", e.target.value)}
									autoComplete="organization"
									error={Boolean(errors.company)}
									maxLength={200}
									placeholder="Acme Corp"
								/>
							</Field>

							<Field
								label={t.deepInquiry.fContactName}
								error={errors.contact_name}
							>
								<Input
									value={form.contact_name}
									onChange={(e) => update("contact_name", e.target.value)}
									autoComplete="name"
									error={Boolean(errors.contact_name)}
									maxLength={200}
									placeholder="Alex Karpov"
								/>
							</Field>

							<Field
								label={t.deepInquiry.fPosition}
								hint={t.deepInquiry.fPositionHint}
								error={errors.position}
							>
								<Input
									value={form.position}
									onChange={(e) => update("position", e.target.value)}
									autoComplete="organization-title"
									error={Boolean(errors.position)}
									maxLength={100}
									placeholder="CISO"
								/>
							</Field>

							<Field
								label={t.deepInquiry.fEmail}
								hint={t.deepInquiry.fEmailHint}
								error={errors.email}
							>
								<Input
									type="email"
									value={form.email}
									onChange={(e) => update("email", e.target.value)}
									autoComplete="email"
									error={Boolean(errors.email)}
									placeholder="alex@acme.test"
								/>
							</Field>

							<Field
								label={t.deepInquiry.fPhone}
								hint={t.deepInquiry.fPhoneHint}
								error={errors.phone}
							>
								<Input
									value={form.phone}
									onChange={(e) => update("phone", e.target.value)}
									autoComplete="tel"
									error={Boolean(errors.phone)}
									maxLength={50}
									placeholder="+7 999 123-45-67 or @yourhandle"
								/>
							</Field>

							<Field
								label={t.deepInquiry.fDomainsText}
								hint={t.deepInquiry.fDomainsTextHint}
								error={errors.domains_text}
							>
								<Textarea
									value={form.domains_text}
									onChange={(e) => update("domains_text", e.target.value)}
									error={Boolean(errors.domains_text)}
									rows={4}
									placeholder={"acme.test\napi.acme.test\nadmin.acme.test"}
								/>
							</Field>

							<Field
								label={t.deepInquiry.fScopeText}
								hint={t.deepInquiry.fScopeTextHint}
								error={errors.scope_text}
							>
								<Textarea
									value={form.scope_text}
									onChange={(e) => update("scope_text", e.target.value)}
									error={Boolean(errors.scope_text)}
									rows={6}
									placeholder="External perimeter only. No DoS, no destructive payloads, no /admin/* during business hours."
								/>
							</Field>

							<Field
								label={t.deepInquiry.fBudgetBand}
								hint={t.deepInquiry.fBudgetBandHint}
								error={errors.budget_band}
							>
								<Select
									value={form.budget_band}
									onChange={(v) =>
										update("budget_band", v as "" | DeepInquiryBudgetBand)
									}
									options={budgetOptions}
								/>
							</Field>

							<Field
								label={t.deepInquiry.fDesiredDate}
								hint={t.deepInquiry.fDesiredDateHint}
								error={errors.desired_date}
							>
								<Input
									type="date"
									value={form.desired_date}
									onChange={(e) => update("desired_date", e.target.value)}
									error={Boolean(errors.desired_date)}
								/>
							</Field>

							<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
								<Checkbox
									checked={form.consent}
									onChange={(v) => update("consent", v)}
									label={
										<span>
											{t.deepInquiry.fConsent}{" "}
											<Link
												to="/legal/privacy"
												style={{
													color: "var(--fg)",
													textDecoration: "underline",
													textUnderlineOffset: 3,
												}}
											>
												{t.deepInquiry.fConsentLink}
											</Link>
											.
										</span>
									}
									danger={Boolean(errors.consent)}
								/>
								{errors.consent && (
									<Mono size={11} color="var(--red)">
										{errors.consent}
									</Mono>
								)}
							</div>

							{submitState === "error" && genericError && (
								<div
									style={{
										padding: "12px 14px",
										border: "1px solid var(--red)",
										color: "var(--red)",
										fontFamily: "'JetBrains Mono', monospace",
										fontSize: 12,
										lineHeight: 1.5,
									}}
								>
									<strong
										style={{
											letterSpacing: "0.04em",
											textTransform: "uppercase",
										}}
									>
										[fail]
									</strong>{" "}
									{genericError}
								</div>
							)}

							<div style={{ display: "flex", gap: 12, marginTop: 8 }}>
								<SubmitButton
									submitting={submitState === "submitting"}
									label={
										submitState === "submitting"
											? t.deepInquiry.submitting
											: t.deepInquiry.submit
									}
								/>
							</div>
						</form>
					</div>
				</main>
			</div>
		</>
	);
}

/* ─────────────────────────────────────────────────────────────────────
   Sub-component: real type="submit" button (Btn renders type="button")
   ───────────────────────────────────────────────────────────────────── */
function SubmitButton({
	submitting,
	label,
}: {
	submitting: boolean;
	label: string;
}): ReactElement {
	const [hov, setHov] = useState(false);
	const base = {
		fontFamily: "'JetBrains Mono', monospace" as const,
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: "0.04em",
		textTransform: "uppercase" as const,
		padding: "9px 14px",
		border: "1px solid var(--fg)",
		borderRadius: 0,
		cursor: submitting ? ("not-allowed" as const) : ("pointer" as const),
		opacity: submitting ? 0.4 : 1,
		transition: "all 120ms cubic-bezier(.22,1,.36,1)",
		display: "inline-flex" as const,
		alignItems: "center" as const,
		justifyContent: "center" as const,
		gap: 8,
		background: hov && !submitting ? "var(--bg)" : "var(--fg)",
		color: hov && !submitting ? "var(--fg)" : "var(--bg)",
	};
	return (
		<button
			type="submit"
			disabled={submitting}
			onMouseEnter={() => setHov(true)}
			onMouseLeave={() => setHov(false)}
			style={base}
		>
			{label} →
		</button>
	);
}
