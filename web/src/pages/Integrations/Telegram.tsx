import { useState } from "react";
import { Send } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { act, Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import {
  Link,
  Row,
  Steps,
  TELEGRAM_PREF_KEYS,
  type TelegramPrefs,
  type TelegramStatus,
  slot,
  sourceLabel,
} from "./shared.tsx";

export function Telegram(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<TelegramStatus>("/api/integrations/telegram");
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState<string>();
  const [mine, setMine] = useState<string>();
  const [chats, setChats] = useState<Array<{ id: string; name: string; type: string }> | null>(
    null,
  );
  const [bindingLink, setBindingLink] = useState("");
  const [prefs, setPrefs] = useState<TelegramPrefs>({});
  const [busy, setBusy] = useState(false);
  const chat = chatId ?? st?.chatId ?? "";
  const connect = async () => {
    const result = await act(() => api<{ url: string }>("/api/integrations/telegram/connect", {}));
    if (result) setBindingLink(result.url);
  };
  const disconnect = async () => {
    if (await act(() => api("/api/integrations/telegram/disconnect", {}))) {
      setBindingLink("");
      reload();
    }
  };
  const savePrefs = async () => {
    if (
      await act(() => api("/api/integrations/telegram/preferences", prefs), t("ig.tg.prefsSaved"))
    ) {
      setPrefs({});
      reload();
    }
  };
  const save = async () => {
    setBusy(true);
    const result = await act(
      () => api("/api/integrations/telegram", { botToken: token, chatId: chat }),
      t("ig.tg.saved"),
    );
    setBusy(false);
    if (result) {
      setToken("");
      setChatId(undefined);
      reload();
    }
  };
  return (
    <Row
      id="telegram"
      icon={Send}
      title="Telegram"
      health={!st ? "loading" : st.configured ? "ok" : "off"}
      {...p}
      summary={
        st?.configured ? (
          <>
            {sourceLabel(t, st.source)} ·{" "}
            {st.binding
              ? t("ig.tg.connected", { id: st.binding.telegram_user_id })
              : t("ig.tg.mineMissing")}
          </>
        ) : (
          t("ig.tg.summaryOff")
        )
      }
    >
      <p className="muted small">{t("ig.tg.body")}</p>
      {st?.canManage && (
        <>
          <Steps>
            <li>{slot(t("ig.tg.s1"), { link: <Link href="https://t.me/BotFather" /> })}</li>
            <li>{t("ig.tg.s2")}</li>
            <li>{t("ig.tg.s3")}</li>
          </Steps>
          <div className="ig-grid">
            <Field
              label={st.configured ? t("ig.tg.tokenNow", { token: st.botToken }) : t("ig.tg.token")}
            >
              <input
                type="password"
                autoComplete="off"
                value={token}
                placeholder={st.configured ? t("ig.keep") : "123456789:AA…"}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
            <Field label={t("ig.tg.chatId")}>
              <input value={chat} onChange={(e) => setChatId(e.target.value)} />
            </Field>
          </div>
          {chats && (
            <div className="ig-chats small">
              {chats.length ? (
                chats.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="sm ghost"
                    onClick={() => setChatId(c.id)}
                  >
                    {c.name || c.id} · {c.type} · {c.id}
                  </button>
                ))
              ) : (
                <span>{t("ig.tg.none")}</span>
              )}
            </div>
          )}
          <div className="ig-actions">
            <button
              type="button"
              className="sm"
              disabled={busy || (!token && !st.configured)}
              onClick={save}
            >
              {busy ? t("ig.checking") : t("ig.save")}
            </button>
            <button
              type="button"
              className="sm ghost"
              disabled={!token && !st.configured}
              onClick={async () => {
                const result = await act(() =>
                  api<Array<{ id: string; name: string; type: string }>>(
                    "/api/integrations/telegram/chats",
                    { botToken: token },
                  ),
                );
                if (result) setChats(result);
              }}
            >
              {t("ig.tg.find")}
            </button>
            {st.source === "platform" && (
              <button
                type="button"
                className="sm ghost"
                onClick={async () => {
                  if (await act(() => api("/api/integrations/telegram/clear", {}))) reload();
                }}
              >
                {t("ig.removePlatform")}
              </button>
            )}
          </div>
        </>
      )}
      {st?.configured && (
        <section className="ig-telegram-settings">
          <h4>{t("ig.tg.interactiveTitle")}</h4>
          <p className="muted small">{t("ig.tg.bindingHint")}</p>
          <p className="small">
            {t("ig.tg.transport")}: <code>{st.mode ?? "off"}</code>
            {st.mode && st.mode !== "off" && (
              <>
                {" "}
                ·{" "}
                <span
                  className={`ig-tg-receiver ${st.receiver?.active ? "is-ok" : "is-warn"}`}
                  role="status"
                >
                  {t(st.receiver?.active ? "ig.tg.receiverActive" : "ig.tg.receiverDown")}
                </span>
              </>
            )}
          </p>
          {st.canManage && (
            <Field label={t("ig.tg.modeTitle")}>
              <select
                aria-label={t("ig.tg.modeTitle")}
                value={st.mode === "polling" ? "polling" : "off"}
                onChange={async (e) => {
                  if (
                    await act(
                      () => api("/api/integrations/telegram/mode", { mode: e.target.value }),
                      t("ig.tg.modeSaved"),
                    )
                  )
                    reload();
                }}
              >
                <option value="off">{t("ig.tg.modeOffOpt")}</option>
                <option value="polling">{t("ig.tg.modePolling")}</option>
              </select>
            </Field>
          )}
          {st.mode === "off" && (
            <p id="tg-connect-hint" className="muted small">
              {t("ig.tg.modeOff")}
            </p>
          )}
          {st.needsRebind && <p>{t("ig.tg.rebind")}</p>}
          <div className="ig-actions">
            {st.binding || st.needsRebind ? (
              <button type="button" className="ghost sm" onClick={disconnect}>
                {t("ig.tg.disconnect")}
              </button>
            ) : (
              <button
                type="button"
                className="sm"
                disabled={st.mode === "off"}
                aria-describedby={st.mode === "off" ? "tg-connect-hint" : undefined}
                onClick={connect}
              >
                {t("ig.tg.connect")}
              </button>
            )}
            {bindingLink && !st.binding && (
              <>
                <a className="btn ghost sm" href={bindingLink} target="_blank" rel="noreferrer">
                  {t("ig.tg.openBinding")}
                </a>
                <button type="button" className="ghost sm" onClick={reload}>
                  {t("ig.tg.checkBinding")}
                </button>
              </>
            )}
          </div>
          <div className="ig-grid">
            {TELEGRAM_PREF_KEYS.map((key) => (
              <label className="row tight small" key={key}>
                <input
                  type="checkbox"
                  checked={prefs[key] ?? st.preferences?.[key] ?? true}
                  onChange={(e) => setPrefs((v) => ({ ...v, [key]: e.target.checked }))}
                />
                {t(`ig.tg.pref.${key}`)}
              </label>
            ))}
            <Field label={t("ig.tg.level")}>
              <select
                aria-label={t("ig.tg.level")}
                value={prefs.level ?? st.preferences?.level ?? "important"}
                onChange={(e) => setPrefs((v) => ({ ...v, level: e.target.value }))}
              >
                {(["all", "important", "critical"] as const).map((l) => (
                  <option key={l} value={l}>
                    {t(`ig.tg.level.${l}`)}
                  </option>
                ))}
              </select>
            </Field>
            {(["quiet_start", "quiet_end"] as const).map((key) => (
              <Field label={t(`ig.tg.${key}`)} key={key}>
                <select
                  aria-label={t(`ig.tg.${key}`)}
                  value={String((key in prefs ? prefs[key] : st.preferences?.[key]) ?? "")}
                  onChange={(e) =>
                    setPrefs((v) => ({
                      ...v,
                      [key]: e.target.value === "" ? null : Number(e.target.value),
                    }))
                  }
                >
                  <option value="">—</option>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
                  ))}
                </select>
              </Field>
            ))}
            <Field label={t("ig.tg.language")}>
              <select
                aria-label={t("ig.tg.language")}
                value={prefs.locale ?? st.preferences?.locale ?? "vi"}
                onChange={(e) => setPrefs((v) => ({ ...v, locale: e.target.value }))}
              >
                <option value="vi">Tiếng Việt</option>
                <option value="en">English</option>
              </select>
            </Field>
          </div>
          <button
            type="button"
            className="ghost sm"
            disabled={!Object.keys(prefs).length}
            onClick={savePrefs}
          >
            {t("ig.save")}
          </button>
          {!st.binding && (
            <details>
              <summary>{t("ig.tg.legacy")}</summary>
              <Field label={t("ig.tg.mine")}>
                <input
                  value={mine ?? st.myChatId ?? ""}
                  onChange={(e) => setMine(e.target.value)}
                />
              </Field>
              <button
                type="button"
                className="ghost sm"
                onClick={async () => {
                  if (
                    await act(() =>
                      api("/api/integrations/telegram/destination", {
                        chatId: mine ?? st.myChatId ?? "",
                      }),
                    )
                  ) {
                    setMine(undefined);
                    reload();
                  }
                }}
              >
                {t("ig.tg.mineSave")}
              </button>
              <p className="muted small">{t("ig.tg.legacyHint")}</p>
            </details>
          )}
          <button
            type="button"
            className="ghost sm"
            onClick={() => act(() => api("/api/integrations/telegram/test", {}), t("ig.tg.sent"))}
          >
            {t("ig.tg.test")}
          </button>
        </section>
      )}
    </Row>
  );
}
