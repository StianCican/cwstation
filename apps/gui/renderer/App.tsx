import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { CwStationGuiApi, GuiDisplayState } from "../api";
import { copy, initialLocale, localizedNotice, LOCALE_STORAGE_KEY, type Locale } from "./locale";

declare global { interface Window { readonly cwstation: CwStationGuiApi; } }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function App(): ReactElement {
  const [state, setState] = useState<GuiDisplayState | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownCall, setOwnCall] = useState("");
  const [peerCall, setPeerCall] = useState("");
  const [inputMode, setInputMode] = useState<"pcm" | "audio">("pcm");
  const [audioBackend, setAudioBackend] = useState<"pulse" | "dshow">(navigator.platform.startsWith("Win") ? "dshow" : "pulse");
  const [audioDevice, setAudioDevice] = useState("");
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = useMemo(() => copy[locale], [locale]);

  useEffect(() => { void window.cwstation.getState().then(setState).catch(reason => setError(errorText(reason))); }, []);
  useEffect(() => {
    if (state?.receiveState !== "running" && !["checking", "confirming", "running"].includes(state?.simulation.phase ?? "")) return;
    const timer = window.setInterval(() => void window.cwstation.getState().then(setState).catch(reason => setError(errorText(reason))), 250);
    return () => window.clearInterval(timer);
  }, [state?.receiveState, state?.simulation.phase]);
  useEffect(() => { setConfirmation(""); }, [state?.simulation.requestId]);
  function changeLocale(next: Locale): void { setLocale(next); try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* optional preference */ } }
  async function run(action: () => Promise<GuiDisplayState>, initializeDraft = false): Promise<void> {
    setBusy(true); setError(null);
    try { const next = await action(); setState(next); if (initializeDraft && next.editing) setDraft(next.proposal?.text ?? ""); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  if (state === null) return <main className="shell loading"><span className="loading-mark" />{error ?? t.connecting}</main>;
  const unavailable = busy || state.stopped;
  const proposal = state.proposal;
  const sim = state.simulation;
  const simBusy = ["checking", "confirming", "running"].includes(sim.phase);
  const setupLocked = unavailable || simBusy || state.receiveState === "running";
  const files = [[inputMode === "pcm" ? "pcm" : "ffmpeg", inputMode === "pcm" ? t.audioSource : t.ffmpeg], ["decoder", t.decoder], ["reply-config", t.replyConfig]] as const;
  const startSimulation = (): void => {
    if (proposal === null) return;
    void run(() => window.cwstation.startSimulation({ sessionId: state.sessionId,
      turnId: proposal.turnId, revision: proposal.revision, text: state.editing ? draft : proposal.text }));
  };
  const receiveLabel = state.audioPaused ? t.audioPaused : ({ idle: t.idle, running: t.receiving, completed: t.completed, stopped: t.stopped, error: t.error } as const)[state.receiveState];
  return <main className="shell">
    <header className="topbar glass-surface">
      <div className="brand-lockup"><div className="app-icon" aria-hidden="true">CW</div><div><p className="eyebrow">{t.appName}</p><h1>{t.title}</h1></div></div>
      <div className="topbar-tools"><label className="language-picker"><span>{t.language}</span><select value={locale} onChange={event => changeLocale(event.target.value as Locale)}><option value="zh-CN">{t.languageChinese}</option><option value="en">{t.languageEnglish}</option></select></label><span className={`status-pill ${state.mode}`}><span className="mode-dot" />{state.mode === "automatic" ? t.modeAutomatic : t.modeManual}</span></div>
    </header>
    <div className="workspace-grid">
    <section className={`setup-panel glass-surface workspace-setup ${state.receiveState === "running" ? "is-live" : ""}`}>
      <div className="section-heading"><div><p className="section-label"><span className="section-index">01</span> / {t.setup}</p><h2>{t.setup}</h2></div><span className={`tag state-tag ${state.receiveState}`}><i />{receiveLabel}</span></div>
      <div className="input-source" role="group" aria-label={t.inputSource}>{(["pcm", "audio"] as const).map(mode => <label key={mode}><input type="radio" name="input-source" value={mode} checked={inputMode === mode} disabled={setupLocked} onChange={() => setInputMode(mode)} /><span>{mode === "pcm" ? t.audioSource : t.liveAudio}</span></label>)}</div>
      {inputMode === "audio" && <div className="audio-settings"><label>{t.audioBackend}<select value={audioBackend} disabled={setupLocked} onChange={event => setAudioBackend(event.target.value as "pulse" | "dshow")}><option value="pulse">Linux · PulseAudio</option><option value="dshow">Windows · DirectShow</option></select></label><label>{t.audioDevice}<input value={audioDevice} disabled={setupLocked} onChange={event => setAudioDevice(event.target.value)} spellCheck={false} /></label></div>}
      <label className="automatic-simulation"><input type="checkbox" checked={state.mode === "automatic"} disabled={unavailable || (state.mode !== "automatic" && (state.editing || sim.phase !== "idle" || !["running", "completed"].includes(state.receiveState)))} onChange={event => void run(() => window.cwstation.setMode(event.target.checked ? "automatic" : "manual"))} /><span>{t.automaticSimulation}</span></label>
      <div className="setup-grid">
        <div className="file-rows">
          {files.map(([role, label]) => <div key={role}><span>{label}</span><strong title={state.files[role === "reply-config" ? "replyConfig" : role] ?? undefined}>{state.files[role === "reply-config" ? "replyConfig" : role] ?? t.notSelected}</strong><button disabled={setupLocked} onClick={() => void run(() => window.cwstation.chooseFile(role))}>{t.choose}</button></div>)}
        </div>
        <div className="station-form"><label>{t.ownCall}<input value={ownCall} disabled={setupLocked} onChange={event => setOwnCall(event.target.value.toUpperCase())} /></label><label>{t.peerCall}<input value={peerCall} disabled={setupLocked} onChange={event => setPeerCall(event.target.value.toUpperCase())} /></label><button className="primary start-button" disabled={setupLocked || !(inputMode === "pcm" ? state.files.pcm : state.files.ffmpeg && audioDevice.trim()) || !state.files.decoder || !state.files.replyConfig || !ownCall.trim() || !peerCall.trim()} onClick={() => void run(() => window.cwstation.startReceive({ ownCall: ownCall.trim(), peerCall: peerCall.trim(), inputMode, ...(inputMode === "audio" ? { audioBackend, audioDevice: audioDevice.trim() } : {}) }))}>{inputMode === "audio" ? t.listen : t.start}</button></div>
      </div>
    </section>
    <div className="workspace-main">
    <div className="notice glass-surface" role="status"><span className="notice-mark" /><span><b>{t.notice}</b>{localizedNotice(state.notice, locale)}</span><span className="session-id">{t.sessionId} {state.sessionId}</span></div>
    <section className="transcript-grid">
      <article className="transcript-section content-surface"><div className="section-heading"><div><p className="section-label"><span className="section-index">02</span> / {t.received}</p><h2>{t.received}</h2></div><span className={`tag state-tag ${state.receiveState}`}><i />{receiveLabel}</span></div><pre className={`cw-text ${state.receivedText ? "has-data" : ""}`}>{state.receivedText || t.noReceived}</pre></article>
      <article className="transcript-section content-surface proposal-section">
        <div className="section-heading"><div><p className="section-label"><span className="section-index">03</span> / {t.proposal}</p><h2>{t.proposal}</h2></div><span className="tag accent">{proposal ? (proposal.source === "ai" ? t.sourceAi : t.sourceLocal) : "—"}</span></div>
        {state.editing ? <div className="inline-editor">
          <label htmlFor="edited-reply">{t.editing}</label>
          <textarea id="edited-reply" autoFocus value={draft} disabled={simBusy} onChange={event => setDraft(event.target.value)} spellCheck={false} rows={5} />
          <p className="caption">{t.editingHint}</p>
        </div> : <>
          {proposal ? <pre className="cw-text proposal-text has-data">{proposal.text}</pre> : <p className="empty-state">{t.noProposal}</p>}
          <div className="proposal-actions"><button className="secondary-action" disabled={unavailable || (simBusy && state.mode !== "automatic")} onClick={() => void run(() => window.cwstation.beginEdit(), true)}><span className="edit-glyph" aria-hidden="true">✎</span>{t.edit}</button></div>
        </>}
        <div className="proposal-actions"><button className="primary" disabled={unavailable || state.mode !== "manual" || proposal === null || (state.inputMode === "audio" ? state.receiveState !== "running" : state.receiveState !== "completed") || sim.phase !== "idle"} onClick={startSimulation}>{t.simulate}</button></div>
        {sim.phase === "confirming" && <div className="simulation-confirmation">
          <label htmlFor="simulation-confirm">{t.confirmText}<pre className="confirmation-text">{sim.text}</pre></label>
          <input id="simulation-confirm" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} />
          <button className="primary" disabled={busy || state.stopped || confirmation !== sim.text} onClick={() => void run(() => window.cwstation.confirmSimulation({ requestId: sim.requestId!, text: confirmation }))}>{t.confirmSimulation}</button>
        </div>}
        {sim.phase !== "idle" && sim.phase !== "confirming" && <p className="caption" role="status">{t.simulationPhases[sim.phase]}{sim.exitCode !== null ? ` (${sim.exitCode})` : ""}</p>}
        {(sim.phase === "completed" || sim.phase === "failed") && <details className="simulation-result"><summary>{t.simulationRecord}</summary><pre>{sim.lines.join("\n")}</pre></details>}
      </article>
    </section>
    </div>
    </div>
    <section className="action-bar glass-surface"><div className="action-context"><span className="action-pulse" /><span>{state.receiveState === "running" ? receiveLabel : t.sessionId + " · " + state.sessionId}</span></div><div className="action-buttons"><button className="danger" disabled={busy || state.stopped} onClick={() => void run(() => window.cwstation.stop())}><span className="stop-glyph" aria-hidden="true" />{t.stop}</button></div></section>
    <footer className="footer">{(state.receiveState === "idle" ? inputMode : state.inputMode) === "audio" ? t.liveFooter : t.footer}</footer>{error !== null && <p className="error" role="alert">{error}</p>}
  </main>;
}
