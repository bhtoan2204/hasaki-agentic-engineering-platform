import type { LatencyResult, TimelineEvent, Rejection, Confidence } from "./correlate.ts";
import type { ParsedRequest } from "./request.ts";

/**
 * Investigation report: a business summary and a developer report, Vietnamese or English. Pure.
 * Everything factual is taken from the validated timeline and latency results; the findings agent's statements are
 * re-validated here (unknown evidence references dropped, classification capped by the evidence they cite). Missing
 * facts are reported as unknown together with the evidence that would settle them — never filled in.
 */

export type InvestigationStatus = "complete" | "partial" | "insufficient_evidence" | "blocked";

export interface SearchSummary {
  id: number;
  query: string;
  earliest: string;
  latest: string;
  status: string;
  mode: string;
  result_count: number | null;
  duration_ms: number | null;
  splunk_url: string;
  error?: string | null;
  step_key?: string | null;
}

export interface Finding {
  statement: string;
  classification: Confidence;
  evidence_refs: string[];
  code_location?: string;
  notes?: string[];
}

export interface ReportInput {
  locale: "vi" | "en";
  parsed: ParsedRequest;
  timeline: TimelineEvent[];
  uncorrelated: TimelineEvent[];
  rejected: Rejection[];
  latencies: LatencyResult[];
  completeness: { complete: boolean; missing: Array<{ objective: string; needed: string }> };
  searches: SearchSummary[];
  findings?: any;
  code?: any;
  access: { connected: boolean; manual_pending: number };
}

const T = {
  vi: {
    title: "Điều tra sự cố production",
    summary: "Tóm tắt",
    status: "Trạng thái",
    statuses: { complete: "Đủ bằng chứng", partial: "Một phần (thiếu bằng chứng)", insufficient_evidence: "Không đủ bằng chứng", blocked: "Bị chặn (không truy cập được log)" },
    entity: "Đối tượng",
    outbound: "Message/request gửi đi",
    outboundAt: "Thời điểm gửi",
    responseAt: "Thời điểm đối tác phản hồi",
    latency: "Độ trễ",
    label: "Shipping label URL",
    generatedAt: "sinh lúc",
    observedAt: "thấy lần đầu lúc (chưa rõ thời điểm sinh thực tế)",
    unknown: "Không xác định",
    needs: "cần",
    timeline: "Dòng thời gian",
    time: "Thời điểm",
    event: "Sự kiện",
    service: "Service",
    evidence: "Bằng chứng",
    confidence: "Độ tin cậy",
    conf: { confirmed: "Xác nhận", inferred: "Suy luận", unknown: "Chưa rõ" },
    ids: "Mã định danh liên quan",
    latencyDetail: "Phân tích độ trễ",
    compared: "So sánh",
    pairing: { request_scope_id: "cùng request/correlation/message id", entity_id: "cùng mã nghiệp vụ (suy luận)", none: "-" },
    findings: "Kết luận",
    hypotheses: "Giả thuyết (chưa xác nhận)",
    missing: "Thiếu hoặc mâu thuẫn",
    next: "Bước điều tra tiếp theo",
    queries: "Các truy vấn SPL đã chạy",
    code: "Repository và vị trí code liên quan",
    rejected: "Nhãn bị loại (không có bằng chứng)",
    uncorrelated: "Sự kiện không liên kết được bằng mã định danh (không dùng để kết luận)",
    readonly: "Chỉ đọc: quy trình này không thay đổi gì trên production.",
    noEvents: "Chưa có sự kiện nào được xác nhận.",
    request: "Yêu cầu",
    window: "Khoảng thời gian tìm",
    attempts: "lần gửi",
    precisionNote: "độ chính xác",
    manualPending: "truy vấn đang chờ người dùng dán kết quả",
    sanitized: "đã che dữ liệu khách hàng và thông tin xác thực",
    droppedRefs: "kết luận có mã bằng chứng không tồn tại",
    rows: "dòng",
  },
  en: {
    title: "Production incident investigation",
    summary: "Summary",
    status: "Status",
    statuses: { complete: "Complete", partial: "Partial (missing evidence)", insufficient_evidence: "Insufficient evidence", blocked: "Blocked (no log access)" },
    entity: "Entity",
    outbound: "Outbound message/request",
    outboundAt: "Sent at",
    responseAt: "Partner responded at",
    latency: "Latency",
    label: "Shipping label URL",
    generatedAt: "generated at",
    observedAt: "first observed at (actual generation time unknown)",
    unknown: "Unknown",
    needs: "needs",
    timeline: "Timeline",
    time: "Time",
    event: "Event",
    service: "Service",
    evidence: "Evidence",
    confidence: "Confidence",
    conf: { confirmed: "Confirmed", inferred: "Inferred", unknown: "Unknown" },
    ids: "Correlation identifiers",
    latencyDetail: "Latency breakdown",
    compared: "Compared",
    pairing: { request_scope_id: "same request/correlation/message id", entity_id: "same business id (inferred)", none: "-" },
    findings: "Findings",
    hypotheses: "Hypotheses (not confirmed)",
    missing: "Missing or conflicting evidence",
    next: "Recommended next steps",
    queries: "SPL queries executed",
    code: "Relevant repositories and code locations",
    rejected: "Rejected labels (no evidence)",
    uncorrelated: "Events not linked by any identifier (not used for conclusions)",
    readonly: "Read-only: this workflow changes nothing in production.",
    noEvents: "No confirmed event yet.",
    request: "Request",
    window: "Search window",
    attempts: "attempts",
    precisionNote: "precision",
    manualPending: "searches waiting for the user to paste results",
    sanitized: "customer data and credentials redacted",
    droppedRefs: "dropped finding refs",
    rows: "rows",
  },
};

const esc = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const RANK: Record<Confidence, number> = { confirmed: 2, inferred: 1, unknown: 0 };

/** Cap the findings agent's claims by the evidence they cite. */
export function validateFindings(raw: any, timeline: TimelineEvent[], knownRefs: Set<string>, locale: "vi" | "en" = "en"): { findings: Finding[]; hypotheses: any[]; dropped: string[] } {
  const byRef = new Map(timeline.map((t) => [t.evidence_ref, t]));
  for (const t of timeline) for (const d of t.duplicates ?? []) byRef.set(d, t);
  const dropped: string[] = [];
  const findings: Finding[] = [];
  for (const f of Array.isArray(raw?.findings) ? raw.findings : []) {
    const statement = String(f?.statement ?? f?.finding ?? "").trim().slice(0, 1000);
    if (!statement) continue;
    const refs: string[] = (Array.isArray(f?.evidence_refs) ? f.evidence_refs : []).map(String);
    const valid = refs.filter((r) => knownRefs.has(r));
    const unknownRefs = refs.filter((r) => !knownRefs.has(r));
    if (unknownRefs.length) dropped.push(`${unknownRefs.join(", ")} (${statement.slice(0, 80)})`);
    const claimed: Confidence = ["confirmed", "inferred", "unknown"].includes(f?.classification) ? f.classification : "unknown";
    // supported at most as strongly as the weakest cited timeline event; uncited / unknown refs → unknown
    const support: Confidence = !valid.length ? "unknown" : valid.map((r) => byRef.get(r)?.confidence ?? "inferred").reduce<Confidence>((a, b) => (RANK[a] <= RANK[b] ? a : b), "confirmed");
    const classification = RANK[claimed] <= RANK[support] ? claimed : support;
    const notes = [
      ...(unknownRefs.length ? [locale === "vi" ? `bỏ mã bằng chứng không tồn tại: ${unknownRefs.join(", ")}` : `unknown evidence references dropped: ${unknownRefs.join(", ")}`] : []),
      ...(classification !== claimed
        ? [locale === "vi" ? `hạ mức từ ${T.vi.conf[claimed]} xuống ${T.vi.conf[classification]} (theo bằng chứng)` : `classification lowered from ${claimed} to ${classification} (evidence)`]
        : []),
    ];
    findings.push({ statement, classification, evidence_refs: valid, ...(f?.code_location ? { code_location: String(f.code_location) } : {}), ...(notes.length ? { notes } : {}) });
  }
  const hypotheses = (Array.isArray(raw?.hypotheses) ? raw.hypotheses : []).map((h: any) => ({
    hypothesis: String(h?.hypothesis ?? h ?? "").slice(0, 800),
    supporting_refs: (Array.isArray(h?.supporting_refs) ? h.supporting_refs : []).map(String).filter((r: string) => knownRefs.has(r)),
    status: "hypothesis",
  }));
  return { findings, hypotheses, dropped };
}

function closestTo(events: TimelineEvent[], anchorIso: string | null, anchorMs: number | null) {
  if (!events.length) return null;
  if (anchorMs === null || !anchorIso) return events[0];
  return [...events].sort((a, b) => Math.abs((a.epoch_us ?? 0) / 1000 - anchorMs) - Math.abs((b.epoch_us ?? 0) / 1000 - anchorMs))[0];
}

export function investigationStatus(i: Pick<ReportInput, "timeline" | "completeness" | "access" | "searches">): InvestigationStatus {
  const confirmed = i.timeline.some((t) => t.confidence === "confirmed");
  if (!confirmed && !i.access.connected && !i.searches.some((s) => s.status === "done")) return "blocked";
  if (!confirmed) return "insufficient_evidence";
  return i.completeness.complete ? "complete" : "partial";
}

export function buildReport(i: ReportInput) {
  const L = T[i.locale];
  const status = investigationStatus(i);
  const knownRefs = new Set([...i.timeline, ...i.uncorrelated].flatMap((t) => [t.evidence_ref, ...(t.duplicates ?? [])]));
  const v = validateFindings(i.findings, i.timeline, knownRefs, i.locale);
  const anchorMs = i.parsed.time.anchor ? Date.parse(i.parsed.time.anchor) : null;
  const requests = i.timeline.filter((t) => t.event_type === "PARTNER_REQUEST_SENT");
  const outboundCandidates = requests.length ? requests : i.timeline.filter((t) => t.event_type === "OUTBOUND_MESSAGE_CREATED" || t.event_type === "MESSAGE_PUBLISHED");
  const outbound = closestTo(outboundCandidates, i.parsed.time.anchor, anchorMs);
  const forOutbound = (l: LatencyResult) => !outbound || l.from.evidence_ref === outbound.evidence_ref;
  const partnerLat = ["partner_sync_response", "partner_callback", "tracking_available"].map((k) => i.latencies.find((l) => l.key === k && forOutbound(l)) ?? i.latencies.find((l) => l.key === k)).filter(Boolean) as LatencyResult[];
  const labelGenerated = i.timeline.find((t) => t.event_type === "SHIPPING_LABEL_URL_GENERATED");
  const labelSeen = i.timeline.find((t) => t.event_type === "SHIPPING_LABEL_URL_OBSERVED" || t.event_type === "SHIPPING_LABEL_URL_PERSISTED");
  const entity = i.parsed.identifiers.find((x) => x.type === "order_code")?.value ?? i.parsed.anchors[0] ?? null;
  const missingFor = (obj: string) => i.completeness.missing.find((m) => m.objective === obj)?.needed;
  const unknownWith = (obj: string) => `${L.unknown}${missingFor(obj) ? ` — ${L.needs}: ${missingFor(obj)}` : ""}`;

  const summary = {
    status,
    entity,
    outbound_message: outbound ? { excerpt: outbound.excerpt, payload: outbound.payload ?? null, evidence_ref: outbound.evidence_ref, service: outbound.service, confidence: outbound.confidence } : null,
    outbound_at: outbound?.timestamp ?? null,
    partner_response: partnerLat.map((l) => ({ key: l.key, label: l.label, at: l.to.timestamp, latency: l.latency_text, latency_ms: l.latency_ms, confidence: l.confidence, from_ref: l.from.evidence_ref, to_ref: l.to.evidence_ref, qualification: l.qualification, notes: l.notes })),
    shipping_label: labelGenerated
      ? { kind: "generated", at: labelGenerated.timestamp, evidence_ref: labelGenerated.evidence_ref, confidence: labelGenerated.confidence }
      : labelSeen
        ? { kind: "first_observed", at: labelSeen.timestamp, evidence_ref: labelSeen.evidence_ref, confidence: "inferred" as Confidence }
        : null,
    attempts: requests.length,
    missing: i.completeness.missing,
  };

  const md: string[] = [];
  md.push(`# ${L.title}`, "", `> ${L.readonly}`, "", `**${L.request}:** ${esc(i.parsed.request)}`, "", `**${L.window}:** ${i.parsed.time.earliest} → ${i.parsed.time.latest} (${i.parsed.time.timezone})${i.parsed.time.notes.length ? ` — ${i.parsed.time.notes.join("; ")}` : ""}`, "");
  md.push(`## ${L.summary}`, "");
  md.push(`- **${L.status}:** ${L.statuses[status]}`);
  md.push(`- **${L.entity}:** ${entity ?? L.unknown}`);
  if (outbound) {
    md.push(`- **${L.outboundAt}:** ${outbound.timestamp ?? L.unknown} (${outbound.service ?? "?"}, \`${outbound.evidence_ref}\`, ${L.conf[outbound.confidence]})${requests.length > 1 ? ` — ${requests.length} ${L.attempts}` : ""}`);
    md.push(`- **${L.outbound}** (${L.sanitized}):`, "", "```", outbound.payload ?? outbound.excerpt, "```", "");
  } else md.push(`- **${L.outbound}:** ${unknownWith("outbound_message")}`);
  if (partnerLat.length)
    for (const l of partnerLat)
      md.push(`- **${l.label}:** ${L.responseAt.toLowerCase()} ${l.to.timestamp ?? L.unknown}; **${L.latency}:** ${l.latency_text ?? L.unknown} (${L.conf[l.confidence]}; \`${l.from.evidence_ref}\` → \`${l.to.evidence_ref}\`)${l.notes.length ? ` — ${l.notes.join("; ")}` : ""}`);
  else if (i.parsed.objectives.includes("partner_response_latency") || i.parsed.objectives.includes("tracking_info")) md.push(`- **${L.responseAt}:** ${unknownWith("partner_response_latency")}`);
  if (labelGenerated) md.push(`- **${L.label}:** ${L.generatedAt} ${labelGenerated.timestamp} (\`${labelGenerated.evidence_ref}\`, ${L.conf[labelGenerated.confidence]})`);
  else if (labelSeen) md.push(`- **${L.label}:** ${L.observedAt} ${labelSeen.timestamp} (\`${labelSeen.evidence_ref}\`)`);
  else if (i.parsed.objectives.includes("shipping_label_time")) md.push(`- **${L.label}:** ${unknownWith("shipping_label_time")}`);
  if (i.access.manual_pending) md.push(`- ${i.access.manual_pending} ${L.manualPending}`);
  md.push("");

  md.push(`## ${L.timeline}`, "");
  if (!i.timeline.length) md.push(L.noEvents, "");
  else {
    md.push(`| # | ${L.time} | ${L.event} | ${L.service} | ${L.ids} | ${L.confidence} | ${L.evidence} |`, "|---|---|---|---|---|---|---|");
    i.timeline.forEach((t, n) => {
      const ids = Object.entries(t.ids).map(([k, vs]) => `${k}=${(vs ?? []).join(",")}`).join("; ");
      const extra = [t.attempt ? `#${t.attempt}` : "", t.delivery ? `delivery ${t.delivery.n}/${t.delivery.of}` : "", t.duplicates?.length ? `+${t.duplicates.length} dup` : ""].filter(Boolean).join(" ");
      md.push(`| ${n + 1} | ${t.timestamp ?? L.unknown} | ${t.event_type}${extra ? ` (${extra})` : ""} | ${esc(t.service ?? "")} | ${esc(ids)} | ${L.conf[t.confidence]} | \`${t.evidence_ref}\` |`);
    });
    md.push("");
  }

  if (i.latencies.length) {
    md.push(`## ${L.latencyDetail}`, "", `| ${L.latency} | ${L.compared} | ${L.latency} | ${L.confidence} | |`, "|---|---|---|---|---|");
    for (const l of i.latencies)
      md.push(`| ${esc(l.label)}${l.attempt ? ` (#${l.attempt})` : ""} | ${l.from.event_type} \`${l.from.evidence_ref}\` ${l.from.timestamp ?? ""} → ${l.to.event_type} \`${l.to.evidence_ref}\` ${l.to.timestamp ?? ""} | ${l.latency_text ?? L.unknown} | ${L.conf[l.confidence]} (${L.pairing[l.pairing]}) | ${esc([l.qualification, ...l.notes].join(" "))} |`);
    md.push("");
  }

  if (v.findings.length) {
    md.push(`## ${L.findings}`, "");
    for (const f of v.findings) md.push(`- [${L.conf[f.classification]}] ${esc(f.statement)}${f.evidence_refs.length ? ` (${f.evidence_refs.map((r) => `\`${r}\``).join(", ")})` : ""}${f.code_location ? ` — ${f.code_location}` : ""}${f.notes?.length ? ` _(${f.notes.join("; ")})_` : ""}`);
    md.push("");
  }
  if (v.hypotheses.length) {
    md.push(`## ${L.hypotheses}`, "");
    for (const h of v.hypotheses) md.push(`- ${esc(h.hypothesis)}${h.supporting_refs.length ? ` (${h.supporting_refs.map((r: string) => `\`${r}\``).join(", ")})` : ""}`);
    md.push("");
  }
  const missingLines = [
    ...i.completeness.missing.map((m) => `${m.objective}: ${m.needed}`),
    ...i.timeline.flatMap((t) => (t.conflicts ?? []).map((c) => `${t.evidence_ref}: ${c}`)),
    ...(Array.isArray(i.findings?.missing_evidence) ? i.findings.missing_evidence.map(String) : []),
    ...v.dropped.map((d) => `${L.droppedRefs}: ${d}`),
  ];
  if (missingLines.length) md.push(`## ${L.missing}`, "", ...missingLines.map((x) => `- ${esc(x)}`), "");
  if (i.rejected.length) md.push(`### ${L.rejected}`, "", ...i.rejected.map((r) => `- \`${esc(r.evidence_ref)}\` ${r.event_type ?? ""}: ${r.reason}`), "");
  if (i.uncorrelated.length) md.push(`### ${L.uncorrelated}`, "", ...i.uncorrelated.map((t) => `- ${t.timestamp ?? "?"} ${t.event_type} \`${t.evidence_ref}\` ${esc(t.service ?? "")}`), "");
  const next = Array.isArray(i.findings?.next_steps) ? i.findings.next_steps.map(String) : [];
  if (next.length) md.push(`## ${L.next}`, "", ...next.map((x: string) => `- ${esc(x)}`), "");

  md.push(`## ${L.queries}`, "");
  for (const s of i.searches)
    md.push(`- #${s.id} [${s.status}${s.mode === "manual" ? ", manual" : ""}] ${s.result_count ?? 0} ${L.rows}${s.duration_ms != null ? `, ${s.duration_ms} ms` : ""} · ${s.earliest} → ${s.latest} · [Splunk](${s.splunk_url})${s.error ? ` — ${esc(s.error)}` : ""}`, "", "  ```spl", `  ${s.query}`, "  ```");
  md.push("");
  const code = [...(Array.isArray(i.code?.code_locations) ? i.code.code_locations : []), ...(Array.isArray(i.code?.log_patterns) ? i.code.log_patterns.filter((p: any) => p?.code_location) : [])];
  if (code.length) {
    md.push(`## ${L.code}`, "");
    for (const c of code.slice(0, 30)) md.push(`- ${esc(c.code_location ?? [c.repo, c.file, c.line].filter(Boolean).join(":"))}${c.description || c.event_type ? ` — ${esc(c.description ?? c.event_type)}` : ""}`);
    md.push("");
  }

  const businessLines = [
    `${L.status}: ${L.statuses[status]}`,
    `${L.entity}: ${entity ?? L.unknown}`,
    `${L.outboundAt}: ${outbound?.timestamp ?? L.unknown}`,
    ...partnerLat.map((l) => `${l.label}: ${l.to.timestamp ?? L.unknown} — ${L.latency.toLowerCase()} ${l.latency_text ?? L.unknown} (${L.conf[l.confidence]})`),
    `${L.label}: ${labelGenerated ? `${L.generatedAt} ${labelGenerated.timestamp}` : labelSeen ? `${L.observedAt} ${labelSeen.timestamp}` : L.unknown}`,
  ];
  return { status, summary, business_summary: businessLines.join("\n"), markdown: md.join("\n"), findings: v.findings, hypotheses: v.hypotheses };
}
