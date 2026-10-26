import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { get, post, put } from "../api";
import { ErrorBox, Field, Icon, Modal, type IconName } from "../components";
import { useI18n } from "../i18n-react";
import { LlmView } from "./Llm";
import { CredentialsSection } from "./SourceCredentials";
import { LANGUAGES, type Language, type MessageKey } from "../i18n";
import { navigate, type SettingsSection } from "../router";

/**
 * The settings panel.
 *
 * A modal with its own navigation, one page per section, and a persistent
 * header carrying the pathless "Open configuration file" action: the file is
 * the record of everything the pages edit, and it is edited by hand when a page
 * does not cover a key. The pages are forms; nothing here shows the raw JSON
 * document, which is exactly what the file is for.
 *
 * Saving always PUTs the *whole* config document (`GET /api/config`, change the
 * fields of one section, PUT back), because the API is a document API — the
 * server restores masked credentials from their `***` form, so a round-tripped
 * document never writes a placeholder over a real secret.
 *
 * Manual edits are handled next to the pages: the file card says whether the
 * file on disk differs from what this process is running, offers "Apply and
 * restart" when it does, and explains a parse error instead of failing quietly.
 */

interface SectionDef {
  id: SettingsSection;
  label: MessageKey;
  icon: IconName;
}

const SECTIONS: SectionDef[] = [
  { id: "general", label: "settings.nav.general", icon: "gear" },
  { id: "llm", label: "settings.nav.llm", icon: "cpu" },
  { id: "proxy", label: "settings.nav.proxy", icon: "cloud" },
  { id: "notifications", label: "settings.nav.notifications", icon: "bell" },
  { id: "harness", label: "settings.nav.harness", icon: "terminal" },
  { id: "docker", label: "settings.nav.docker", icon: "box" },
  { id: "retry", label: "settings.nav.retry", icon: "refresh" },
  // Git credentials are global settings, referenced by Project id — they belong
  // beside the other app-wide settings, not in a page of their own.
  { id: "credentials", label: "settings.nav.credentials", icon: "key" },
  { id: "about", label: "settings.nav.about", icon: "cpu" },
];

/** What `/api/docker/status` answers. */
interface DockerProbe {
  available: boolean;
  binary: string;
  version?: string;
  reason?: "not-installed" | "daemon-unreachable" | "probe-failed";
  detail?: string | null;
}

/** What `/api/settings/file` answers. */
interface FileInfo {
  path: string;
  config: Record<string, unknown>;
  file: { path: string; text: string; error?: string; mtimeMs: number; revision: string };
  pending: boolean;
  applied: { revision: string; at: string };
  history: Array<{ at: string; source: "ui" | "file"; keys: string[] }>;
}

/** Proxy test result from `POST /api/proxy/test`. */
interface ProxyTestResult {
  ok: boolean;
  proxyUrl: string;
  status?: number;
  latencyMs: number;
  error?: string;
}

/**
 * Every write goes through this section: it PUTs the changed document but does
 * not update the local copy until the server answers, so a rejected document
 * never leaves the form looking saved.
 */
type SaveSection = (section: Record<string, unknown> | null) => Promise<void>;

interface SettingsProps {
  /** The section to open; the URL carries it so a reload stays on the page. */
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
}

/**
 * Tells the panel whether the page currently shown has unsaved edits.
 *
 * Each section keeps its own `form` and derives `dirty` locally, so the panel
 * has no way to know. `SaveRow` reports it here; closing the panel consults it
 * instead of dropping the edit on the floor.
 */
const DirtyContext = createContext<((dirty: boolean) => void) | null>(null);

export function SettingsView({ section, onSection, onClose }: SettingsProps) {
  const { t } = useI18n();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [file, setFile] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const navRef = useRef<HTMLButtonElement | null>(null);
  // Shown when closing with unsaved edits: the edits are not thrown away by a
  // stray Escape or a click outside the dialog.
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else onClose();
  }, [dirty, onClose]);

  const load = useCallback(async () => {
    try {
      const [cfg, info] = await Promise.all([
        get<Record<string, unknown>>("/api/config", undefined, true),
        get<FileInfo>("/api/settings/file", undefined, true),
      ]);
      setConfig(cfg);
      setFile(info);
      setError(null);
      return info;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape closes the panel; the keyboard focus starts on the selected section.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape first dismisses the unsaved-changes question, if it is open.
      if (e.key === "Escape") {
        setConfirmClose((asking) => {
          if (asking) return false;
          requestClose();
          return false;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    navRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  /** Writes the whole document (transitive change) and keeps the local copy. */
  const saveDocument = useCallback(
    async (next: Record<string, unknown>) => {
      setSaving(true);
      setError(null);
      try {
        const saved = await put<Record<string, unknown>>("/api/config", next);
        setConfig(saved);
        setJustSaved(true);
        window.setTimeout(() => setJustSaved(false), 1800);
        // The file now holds what was saved: refresh its identity so the card
        // stops claiming an unapplied edit.
        void get<FileInfo>("/api/settings/file", undefined, true).then(setFile).catch(() => {});
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        throw e;
      } finally {
        setSaving(false);
      }
    },
    []
  );

  const saveSection: SaveSection = useMemo(
    () => async (sectionValue) => {
      if (!config) return;
      // `notifications` is a whole-section replacement on purpose: clearing the
      // webhook URL is done by omitting it, and a shallow merge at the server
      // would keep the old URL. Every other section is merged key by key.
      const next = sectionValue === null ? config : { ...config, ...sectionValue };
      await saveDocument(next);
    },
    [config, saveDocument]
  );

  const openFile = async () => {
    setOpenError(null);
    try {
      await post("/api/settings/open");
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * Applies the edited file and waits for the server to come back.
   *
   * A restart drops every open connection, so the health probe is what
   * distinguishes "restarted" from "the request went through but the process is
   * gone": it polls until the server answers again, and after a timeout it says
   * so instead of leaving a spinner.
   */
  const applyFile = async () => {
    setApplying(true);
    setApplyNote(null);
    try {
      const result = await post<{ applied: boolean; restarted: boolean }>("/api/settings/apply");
      if (!result.restarted) {
        setApplyNote(t("settings.file.appliedNoRestart"));
        await load();
        setApplying(false);
        return;
      }
      setApplyNote(t("settings.file.restarting"));
      const came = await waitForServer();
      setApplyNote(came ? t("settings.file.restarted") : t("settings.file.restartTimeout"));
      if (came) await load();
    } catch (e) {
      setApplyNote(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <DirtyContext.Provider value={setDirty}>
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={t("settings.title")}>
      <div className="settings-mask" onClick={requestClose} />
      <div className="settings-panel">
        <nav className="settings-nav" aria-label={t("settings.title")}>
          <div className="settings-nav-title">{t("settings.title")}</div>
          <div className="settings-nav-list">
            {SECTIONS.map((entry, index) => (
              <button
                key={entry.id}
                ref={index === 0 ? navRef : undefined}
                className={`settings-nav-cell ${entry.id === section ? "active" : ""}`}
                aria-current={entry.id === section ? "page" : undefined}
                onClick={() => onSection(entry.id)}
              >
                <Icon name={entry.icon} size={15} />
                <span className="settings-nav-label">{t(entry.label)}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="settings-content">
          <header className="settings-header">
            <span className="settings-actions">
              {openError && (
                <span className="settings-action-error" role="alert">
                  {t("settings.openFile.error")}
                </span>
              )}
              {saving && <span className="settings-status">{t("settings.saving")}</span>}
              {!saving && justSaved && <span className="settings-status ok">{t("settings.saved")}</span>}
              <button className="btn-outline" onClick={openFile} title={file?.path}>
                {t("settings.openFile")}
              </button>
              <button className="settings-close" onClick={requestClose} aria-label={t("settings.close")} title={t("settings.close")}>
                <Icon name="close" size={16} />
              </button>
            </span>
          </header>

          <div className="settings-body">
            {error && <ErrorBox message={error} />}
            {!config && !error && <div className="settings-loading" role="status" />}
            {config && (
              <FileCard
                info={file}
                applying={applying}
                note={applyNote}
                onReload={async () => {
                  setApplyNote(null);
                  await load();
                }}
                onApply={applyFile}
                onOpen={openFile}
              />
            )}
            {config && current.id === "general" && <GeneralSection config={config} />}
            {/* Providers and models live in the same file as the other pages
                (its `providers` section), so they are a section here rather
                than a separate view with its own idea of where they live. */}
            {config && current.id === "llm" && (
              <div className="settings-page settings-page-wide">
                <h2 className="settings-page-title">{t("settings.nav.llm")}</h2>
                <p className="settings-page-desc">{t("llm.description")}</p>
                <LlmView embedded />
              </div>
            )}
            {config && current.id === "proxy" && <ProxySection config={config} save={saveSection} />}
            {config && current.id === "notifications" && (
              <NotificationsSection config={config} save={saveSection} />
            )}
            {config && current.id === "harness" && <HarnessSection config={config} save={saveSection} />}
            {config && current.id === "docker" && <DockerSection config={config} save={saveSection} />}
            {config && current.id === "retry" && <RetrySection config={config} save={saveSection} />}
            {config && current.id === "credentials" && (
              <div className="settings-page">
                <h2 className="settings-page-title">{t("settings.nav.credentials")}</h2>
                <p className="settings-page-desc">{t("credentials.description")}</p>
                <CredentialsSection />
              </div>
            )}
            {config && current.id === "about" && <AboutSection config={config} />}
          </div>
        </div>
      </div>

      {/* Closing with unsaved edits asks instead of discarding them: an Escape
          or a click on the mask is easy to do by accident, and the edit is gone. */}
      {confirmClose && (
        <Modal title={t("settings.unsavedTitle")} onClose={() => setConfirmClose(false)}>
          <p>{t("settings.unsavedBody")}</p>
          <div className="modal-actions">
            <button onClick={() => setConfirmClose(false)}>{t("settings.keepEditing")}</button>
            <button className="danger" onClick={onClose}>{t("settings.discardAndClose")}</button>
          </div>
        </Modal>
      )}
    </div>
    </DirtyContext.Provider>
  );
}

function useIsLoopback(): boolean {
  return useMemo(() => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname), []);
}

/** Polls `/api/health` (unauthenticated) until the restarted server answers. */
async function waitForServer(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // The old process may still answer for a moment after its restart was
  // scheduled, so a single early success proves nothing: require two successes
  // a beat apart, which is what "the new process is listening" looks like.
  let successes = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) {
        successes += 1;
        if (successes >= 2) return true;
      } else {
        successes = 0;
      }
    } catch {
      successes = 0;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  return false;
}

/**
 * The configuration file card: path, whether what is on disk is what is
 * running, and the two actions that make hand editing usable (open it; apply
 * and restart). A file that does not parse is reported with its error and
 * cannot be applied — it does not replace the running config.
 */
function FileCard(props: {
  info: FileInfo | null;
  applying: boolean;
  note: string | null;
  onReload: () => Promise<void>;
  onApply: () => Promise<void>;
  onOpen: () => Promise<void>;
}) {
  const { info, applying, note } = props;
  const { t } = useI18n();
  const loopback = useIsLoopback();
  if (!info) return null;
  const broken = info.file.error !== undefined;
  const canApply = info.pending && !broken;
  return (
    <section className="settings-filecard">
      <div className="settings-filecard-head">
        <div>
          <div className="settings-filecard-title">{t("settings.file.title")}</div>
          <div className="settings-filecard-path mono" title={info.path}>
            {info.path}
          </div>
        </div>
        <div className="settings-filecard-actions">
          <button className="btn-outline" onClick={() => void props.onReload()} disabled={applying}>
            {t("settings.file.reload")}
          </button>
          <button className="btn-primary" onClick={() => void props.onApply()} disabled={!canApply || applying}>
            {applying ? t("settings.file.applying") : t("settings.file.apply")}
          </button>
        </div>
      </div>

      <div className="settings-filecard-state">
        {broken ? (
          <span className="settings-filecard-error" role="alert">
            {t("settings.file.broken", { error: info.file.error ?? "" })}
          </span>
        ) : info.pending ? (
          <span className="settings-filecard-pending">
            {t("settings.file.pending")} {t("settings.file.pendingApplied", { at: formatTime(info.applied.at) })}
          </span>
        ) : (
          <span className="muted">
            {t("settings.file.appliedMark", { at: formatTime(info.applied.at) })} ·{" "}
            {t("settings.file.updated")} {info.file.mtimeMs ? formatTime(new Date(info.file.mtimeMs).toISOString()) : "—"}
          </span>
        )}
      </div>
      {note && <div className="settings-filecard-note">{note}</div>}
      <div className="settings-hint">
        {t("settings.file.hint")}
        {!loopback && <> {t("settings.file.notLocal")}</>}
      </div>
    </section>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * A page with a title, an optional description, its fields, and its own save
 * row. Each page exists as a component so switching pages remounts its form and
 * drops half-typed values that belong to the page the user left.
 */
function Page(props: { title: MessageKey; description?: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="settings-page">
      <h2 className="settings-page-title">{t(props.title)}</h2>
      {props.description && <p className="settings-page-desc">{props.description}</p>}
      {props.children}
    </div>
  );
}

/** The save/discard row every editable page ends with. */
function SaveRow(props: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  hint: MessageKey;
}) {
  const { t } = useI18n();
  const reportDirty = useContext(DirtyContext);
  useEffect(() => {
    reportDirty?.(props.dirty);
    return () => reportDirty?.(false);
  }, [props.dirty, reportDirty]);
  return (
    <div className="settings-save-row">
      <button className="btn-primary" disabled={!props.dirty || props.saving} onClick={props.onSave}>
        {props.saving ? t("settings.saving") : t("settings.save")}
      </button>
      <button className="btn-outline" disabled={!props.dirty || props.saving} onClick={props.onDiscard}>
        {t("settings.discard")}
      </button>
      <span className="settings-hint">{t(props.hint)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

function GeneralSection({ config }: { config: Record<string, unknown> }) {
  const { t, language, setLanguage } = useI18n();
  const server = (config.server ?? {}) as { host?: string; port?: number };
  const languages: ReadonlyArray<{ id: Language; label: string }> = LANGUAGES;
  const dir = (config as { dataDir?: string }).dataDir;
  return (
    <Page title="settings.nav.general">
      <div className="settings-field-row">
        <div className="settings-field-label">{t("general.language")}</div>
        <div className="settings-segmented" role="group" aria-label={t("general.language")}>
          {languages.map((entry) => (
            <button
              key={entry.id}
              aria-pressed={entry.id === language}
              onClick={() => setLanguage(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-hint settings-field-hint">{t("general.language.hint")}</div>

      <dl className="settings-facts">
        <dt>{t("general.server")}</dt>
        <dd className="mono">http://{server.host ?? "127.0.0.1"}:{server.port ?? "7377"}</dd>
        <dt>{t("general.dataDir")}</dt>
        <dd className="mono">{dir ?? "~/.fabric"}</dd>
        <dt>{t("general.version")}</dt>
        <dd className="mono">0.1.0</dd>
      </dl>
      <div className="settings-hint settings-field-hint">{t("general.loopback")}</div>
    </Page>
  );
}

function ProxySection(props: { config: Record<string, unknown>; save: SaveSection }) {
  const { t } = useI18n();
  const stored = (props.config.proxy ?? {}) as { enabled?: boolean; scheme?: string; host?: string; port?: number };
  const initial = {
    enabled: Boolean(stored.enabled),
    scheme: stored.scheme === "socks5" ? "socks5" : ("http" as "http" | "socks5"),
    host: stored.host ?? "",
    port: stored.port != null ? String(stored.port) : "",
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ProxyTestResult | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const port = Number(form.port);
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;

  const patch = (next: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...next }));
    setFormError(null);
  };

  const save = async () => {
    if (form.enabled && (!form.host.trim() || !portValid)) {
      setFormError(t("proxy.required"));
      return;
    }
    setBusy(true);
    try {
      await props.save({
        proxy: {
          enabled: form.enabled,
          scheme: form.scheme,
          host: form.host.trim(),
          ...(portValid ? { port } : {}),
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    const host = form.host.trim();
    if (!host || !portValid) {
      setTest({ ok: false, proxyUrl: "", latencyMs: 0, error: t("proxy.testNeedsInput") });
      return;
    }
    setTesting(true);
    setTest(null);
    try {
      setTest(await post<ProxyTestResult>("/api/proxy/test", { scheme: form.scheme, host, port }));
    } catch (e) {
      setTest({ ok: false, proxyUrl: "", latencyMs: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Page title="settings.nav.proxy" description={t("proxy.description")}>
      <label className="settings-switch">
        <input type="checkbox" checked={form.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span>{t("proxy.enabled")}</span>
      </label>
      <Field label={t("proxy.scheme")}>
        <select value={form.scheme} onChange={(e) => patch({ scheme: e.target.value as "http" | "socks5" })}>
          <option value="http">http</option>
          <option value="socks5">socks5</option>
        </select>
      </Field>
      <div className="form-grid-2">
        <Field label={t("proxy.host")}>
          <input className="mono" value={form.host} placeholder="127.0.0.1" onChange={(e) => patch({ host: e.target.value })} />
        </Field>
        <Field label={t("proxy.port")}>
          <input
            className="mono"
            value={form.port}
            placeholder="7890"
            inputMode="numeric"
            onChange={(e) => patch({ port: e.target.value })}
          />
        </Field>
      </div>
      {formError && <div className="settings-error-line">{formError}</div>}
      <div className="settings-inline-actions">
        <button className="btn-outline" onClick={() => void runTest()} disabled={testing}>
          {testing ? t("proxy.testing") : t("proxy.test")}
        </button>
        {test && (
          <span className={test.ok ? "settings-result ok" : "settings-result bad"}>
            {test.ok
              ? t("proxy.testOk", { status: test.status ?? "?", latency: test.latencyMs, proxyUrl: test.proxyUrl })
              : t("proxy.testFailed", { error: test.error ?? "—" })}
          </span>
        )}
      </div>
      <div className="settings-hint">{t("proxy.hint")}</div>
      <SaveRow dirty={dirty} saving={busy} onSave={() => void save()} onDiscard={() => setForm(initial)} hint="settings.restartHint" />
    </Page>
  );
}

/**
 * Notification header lines, edited as `name: value` text.
 *
 * The read gives every value as a fixed mask; sending the mask back means
 * "unchanged" (the server restores the stored value under that exact name), so
 * a masked line is passed through verbatim and any other value replaces it.
 */
function NotificationsSection(props: { config: Record<string, unknown>; save: SaveSection }) {
  const { t } = useI18n();
  headerLineError = (line: string) => t("settings.notifications.badHeader", { line });
  const raw = (props.config.notifications ?? {}) as {
    enabled?: boolean;
    url?: string;
    urlSet?: boolean;
    headers?: Record<string, string>;
    timeoutMs?: number;
  };
  const initial = {
    enabled: Boolean(raw.enabled),
    url: "",
    clearUrl: false,
    headers: headerLines(raw.headers ?? {}),
    timeout: raw.timeoutMs != null ? String(raw.timeoutMs) : "",
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const dirty =
    form.enabled !== initial.enabled ||
    form.url !== "" ||
    form.clearUrl ||
    form.timeout !== initial.timeout ||
    form.headers !== initial.headers;

  const save = async () => {
    const url = form.url.trim();
    if (form.enabled && !url && !raw.urlSet) {
      setFormError(t("notifications.needUrl"));
      return;
    }
    setBusy(true);
    try {
      const headers = parseHeaderLines(form.headers);
      await props.save({
        notifications: {
          enabled: form.enabled,
          ...(url ? { url } : {}),
          ...(form.clearUrl ? { url: "" } : {}),
          ...(headers ? { headers } : {}),
          ...(form.timeout.trim() ? { timeoutMs: Number(form.timeout) } : {}),
        },
      });
      setForm((f) => ({ ...f, url: "", clearUrl: false }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="settings.nav.notifications" description={t("notifications.description")}>
      <label className="settings-switch">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span>{t("notifications.enabled")}</span>
      </label>

      <Field label={t("notifications.url")}>
        <input
          className="mono"
          value={form.url}
          placeholder={
            raw.urlSet && !form.clearUrl
              ? t("notifications.url.masked", { masked: raw.url ?? "" })
              : t("notifications.url.placeholder")
          }
          onChange={(e) => setForm({ ...form, url: e.target.value, clearUrl: false })}
        />
      </Field>
      <div className="settings-inline-actions">
        <span className="settings-hint">
          {raw.urlSet && !form.clearUrl
            ? t("notifications.url.masked", { masked: raw.url ?? "" })
            : t("notifications.url.unset")}
        </span>
        {raw.urlSet && !form.clearUrl && (
          <button className="btn-outline" onClick={() => setForm({ ...form, url: "", clearUrl: true })}>
            {t("notifications.clear")}
          </button>
        )}
      </div>
      <div className="settings-hint">{t("notifications.url.hint")}</div>

      <Field label={t("notifications.headers")}>
        <textarea
          rows={3}
          className="mono"
          value={form.headers}
          onChange={(e) => setForm({ ...form, headers: e.target.value })}
        />
      </Field>
      <div className="settings-hint">{t("notifications.headers.hint")}</div>

      <Field label={t("notifications.timeout")}>
        <input
          className="mono"
          value={form.timeout}
          placeholder="5000"
          inputMode="numeric"
          onChange={(e) => setForm({ ...form, timeout: e.target.value })}
        />
      </Field>

      {formError && <div className="settings-error-line">{formError}</div>}
      <SaveRow dirty={dirty} saving={busy} onSave={() => void save()} onDiscard={() => setForm(initial)} hint="settings.restartHint" />
    </Page>
  );
}

function headerLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** The message a malformed header line reports; set from the dictionary at render time. */
let headerLineError = (line: string) => `Header line is not "name: value": ${line}`;

/** Parses `name: value` lines; `null` when there are none (nothing to send). */
function parseHeaderLines(text: string): Record<string, string> | null {
  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(":");
      if (at < 0) throw new Error(headerLineError(line));
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** What `/api/harness/clis` answers. */
interface HarnessCliRow {
  id: string;
  command: string;
  path?: string;
  version?: string;
  source?: "configured" | "path" | "user-dirs" | "login-shell";
  offPath: boolean;
  problem?: string;
}

interface HarnessCliReport {
  clis: HarnessCliRow[];
  shell: { command: string | null; pathFound: boolean };
}

/**
 * Each harness CLI's path override, with what detection found on this machine.
 *
 * The override is the exception, not the rule: an empty field means "detect it",
 * and detection looks past PATH (the folders npm/bun/nvm/Homebrew install into,
 * then the login shell's PATH) because the server may be a Dock-launched app
 * whose PATH is launchd's. The row therefore shows the resolved path, its
 * version, and — when the folder is not on a terminal's PATH — why a terminal's
 * `which` misses a CLI that runs perfectly here.
 */
function HarnessSection(props: { config: Record<string, unknown>; save: SaveSection }) {
  const { t } = useI18n();
  const read = (key: string) => {
    const section = (props.config[key] ?? {}) as { bin?: string };
    return section.bin ?? "";
  };
  const initial = {
    opencode: read("opencode"),
    pi: read("pi"),
    codex: read("codex"),
    dsh: read("dsh"),
    claude: read("claudeCode"),
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<HarnessCliReport | null>(null);
  const [detecting, setDetecting] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const rows: Array<{ key: keyof typeof form; label: string; command: string }> = [
    { key: "opencode", label: "opencode", command: "opencode" },
    { key: "pi", label: "pi", command: "pi" },
    { key: "codex", label: "codex", command: "codex" },
    { key: "dsh", label: "dsh (DSH)", command: "dsh" },
    { key: "claude", label: "claude (Claude Code)", command: "claude" },
  ];
  const detect = useCallback(async (refresh: boolean) => {
    setDetecting(true);
    try {
      setReport(await get<HarnessCliReport>(`/api/harness/clis${refresh ? "?refresh=1" : ""}`, undefined, true));
    } catch {
      // Detection is informational: a failed probe must not hide the form.
      setReport(null);
    } finally {
      setDetecting(false);
    }
  }, []);
  useEffect(() => {
    void detect(false);
  }, [detect]);
  const found = (command: string): HarnessCliRow | undefined =>
    report?.clis.find((cli) => cli.command === command || cli.id === command);
  const save = async () => {
    setBusy(true);
    try {
      await props.save({
        opencode: { bin: form.opencode.trim() },
        pi: { bin: form.pi.trim() },
        codex: { bin: form.codex.trim() },
        dsh: { bin: form.dsh.trim() },
        claudeCode: {
          bin: form.claude.trim(),
          projectsDir: ((props.config.claudeCode ?? {}) as { projectsDir?: string }).projectsDir ?? "",
        },
      });
      // The saved override changes what detection answers, so look again.
      void detect(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="settings.nav.harness" description={t("harness.description")}>
      {rows.map((row) => {
        const detected = found(row.command);
        return (
          <Field key={row.key} label={row.label}>
            <input
              className="mono"
              value={form[row.key]}
              // The command name, not the detected path: the path is on the line
              // below with its version, and a placeholder that looks like a
              // stored value is the one thing this page must not do — an empty
              // field means "detect it".
              placeholder={row.command}
              onChange={(e) => setForm({ ...form, [row.key]: e.target.value })}
            />
            <HarnessCliState row={detected} detecting={detecting} />
          </Field>
        );
      })}
      {report && (
        <div className="settings-hint">
          {report.shell.pathFound
            ? t("harness.shellOk", { shell: report.shell.command ?? "" })
            : t("harness.shellUnknown", { shell: report.shell.command ?? "" })}
          <div style={{ marginTop: 6 }}>
            <button className="btn-outline" disabled={detecting} onClick={() => void detect(true)}>
              {detecting ? t("harness.checking") : t("harness.recheck")}
            </button>
          </div>
        </div>
      )}
      <SaveRow dirty={dirty} saving={busy} onSave={() => void save()} onDiscard={() => setForm(initial)} hint="settings.restartHint" />
    </Page>
  );
}

/** One line under a CLI field: what detection found, or why it found nothing. */
function HarnessCliState(props: { row?: HarnessCliRow; detecting: boolean }) {
  const { t } = useI18n();
  if (props.detecting && !props.row) return <div className="settings-hint">{t("harness.checking")}</div>;
  if (!props.row) return null;
  const { row } = props;
  if (!row.path) {
    return (
      <div className="settings-hint settings-field-hint">
        {row.problem ? t("harness.configuredProblem", { problem: row.problem }) : t("harness.missing")}
      </div>
    );
  }
  const source = row.source ? t(`harness.source.${row.source}` as MessageKey) : "";
  return (
    <div className="settings-hint settings-field-hint">
      <span className="mono">{row.path}</span>
      {row.version && <span> · {row.version}</span>}
      {source && <span> · {source}</span>}
      {row.offPath && <div className="settings-warn">{t("harness.offPath")}</div>}
    </div>
  );
}

function DockerSection(props: { config: Record<string, unknown>; save: SaveSection }) {
  const { t } = useI18n();
  const stored = (props.config.docker ?? {}) as { socket?: string; defaultImage?: string };
  const initial = { socket: stored.socket ?? "", image: stored.defaultImage ?? "" };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const save = async () => {
    setBusy(true);
    try {
      await props.save({ docker: { socket: form.socket.trim(), defaultImage: form.image.trim() } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="settings.nav.docker" description={t("docker.description")}>
      <Field label={t("docker.socket")}>
        <input
          className="mono"
          value={form.socket}
          placeholder="/var/run/docker.sock"
          onChange={(e) => setForm({ ...form, socket: e.target.value })}
        />
      </Field>
      <Field label={t("docker.image")}>
        <input
          className="mono"
          value={form.image}
          placeholder="agentfabric-opencode:latest"
          onChange={(e) => setForm({ ...form, image: e.target.value })}
        />
      </Field>
      <DockerStatus />
      <SaveRow dirty={dirty} saving={busy} onSave={() => void save()} onDiscard={() => setForm(initial)} hint="settings.restartHint" />
    </Page>
  );
}

/**
 * Whether this machine can actually run a containerized runtime.
 *
 * A Project task refuses to run anywhere else, so with no working Docker the
 * user is stuck — and "the CLI is installed but the daemon is not running" looks
 * identical to "not installed at all" from the outside. Re-probed on demand
 * because it is the Docker app's state that changes, not ours.
 */
function DockerStatus() {
  const { t } = useI18n();
  const [state, setState] = useState<DockerProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const probe = useCallback(async () => {
    setBusy(true);
    try {
      setState(await get<DockerProbe>("/api/docker/status", undefined, true));
    } catch (e) {
      setState({ available: false, binary: "docker", reason: "probe-failed", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void probe();
  }, [probe]);
  if (!state) return <div className="settings-hint">{t("docker.checking")}</div>;
  const heading = state.available
    ? t("docker.ready").replace("{version}", state.version ?? "?")
    : state.reason === "not-installed"
      ? t("docker.missing")
      : state.reason === "daemon-unreachable"
        ? t("docker.stopped")
        : t("docker.failed");
  return (
    <div className={`settings-hint ${state.available ? "" : "settings-warn"}`} role="status">
      <strong>{heading}</strong>
      {!state.available && state.detail && (
        <div className="mono" style={{ marginTop: 4, fontSize: 11, opacity: 0.8 }}>{state.detail}</div>
      )}
      <button className="btn-outline" style={{ marginTop: 6 }} disabled={busy} onClick={() => void probe()}>
        {busy ? t("docker.checking") : t("docker.recheck")}
      </button>
    </div>
  );
}

function RetrySection(props: { config: Record<string, unknown>; save: SaveSection }) {
  const { t } = useI18n();
  const stored = (props.config.autoRetry ?? {}) as {
    enabled?: boolean;
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  const initial = {
    enabled: stored.enabled !== false,
    maxAttempts: stored.maxAttempts != null ? String(stored.maxAttempts) : "",
    baseDelay: stored.baseDelayMs != null ? String(stored.baseDelayMs) : "",
    maxDelay: stored.maxDelayMs != null ? String(stored.maxDelayMs) : "",
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const numberOrUndefined = (text: string) => (text.trim() === "" ? undefined : Number(text));
  const save = async () => {
    setBusy(true);
    try {
      await props.save({
        autoRetry: {
          enabled: form.enabled,
          ...(numberOrUndefined(form.maxAttempts) !== undefined ? { maxAttempts: Number(form.maxAttempts) } : {}),
          ...(numberOrUndefined(form.baseDelay) !== undefined ? { baseDelayMs: Number(form.baseDelay) } : {}),
          ...(numberOrUndefined(form.maxDelay) !== undefined ? { maxDelayMs: Number(form.maxDelay) } : {}),
        },
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="settings.nav.retry" description={t("retry.description")}>
      <label className="settings-switch">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span>{t("retry.enabled")}</span>
      </label>
      <div className="form-grid-2">
        <Field label={t("retry.maxAttempts")}>
          <input
            className="mono"
            value={form.maxAttempts}
            placeholder="2"
            inputMode="numeric"
            onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })}
          />
        </Field>
        <Field label={t("retry.baseDelay")}>
          <input
            className="mono"
            value={form.baseDelay}
            placeholder="2000"
            inputMode="numeric"
            onChange={(e) => setForm({ ...form, baseDelay: e.target.value })}
          />
        </Field>
      </div>
      <Field label={t("retry.maxDelay")}>
        <input
          className="mono"
          value={form.maxDelay}
          placeholder="60000"
          inputMode="numeric"
          onChange={(e) => setForm({ ...form, maxDelay: e.target.value })}
        />
      </Field>
      <div className="settings-hint">{t("retry.formula")}</div>
      <SaveRow dirty={dirty} saving={busy} onSave={() => void save()} onDiscard={() => setForm(initial)} hint="settings.retryLive" />
    </Page>
  );
}

/** Read-only facts: where things live, and the environment variables that override them. */
function AboutSection({ config }: { config: Record<string, unknown> }) {
  const { t } = useI18n();
  const envRows: Array<[string, MessageKey]> = [
    ["AGENTFABRIC_API", "settings.env.api"],
    ["AGENTFABRIC_DATA_DIR", "settings.env.dataDir"],
    ["AGENTFABRIC_HOST / AGENTFABRIC_PORT", "settings.env.hostPort"],
    ["AGENTFABRIC_DOCKER_BIN", "settings.env.dockerBin"],
    ["AGENTFABRIC_OPENCODE_BIN", "settings.env.opencodeBin"],
    ["AGENTFABRIC_WEB_DIR", "settings.env.webDir"],
  ];
  const server = (config.server ?? {}) as { host?: string; port?: number };
  return (
    <Page title="settings.nav.about">
      <dl className="settings-facts">
        <dt>{t("general.server")}</dt>
        <dd className="mono">http://{server.host ?? "127.0.0.1"}:{server.port ?? "7377"}</dd>
        <dt>{t("general.version")}</dt>
        <dd className="mono">0.1.0</dd>
      </dl>
      <h3 className="settings-subtitle">{t("general.env")}</h3>
      <table className="settings-env">
        <tbody>
          {envRows.map(([name, description]) => (
            <tr key={name}>
              <td className="mono">{name}</td>
              <td className="muted">{t(description)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="settings-hint">{t("general.env.hint")}</div>
      <div className="settings-inline-actions">
        <button className="btn-outline" onClick={() => navigate("/usage")}>
          {t("nav.usage")}
        </button>
      </div>
    </Page>
  );
}
