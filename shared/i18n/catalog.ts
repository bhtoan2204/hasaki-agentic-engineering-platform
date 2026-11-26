/** Additional UI copy. Merged into the shared dictionary; keys must exist in both locales. */
import { aeMessages } from "./catalog/ae.ts";
import { anMessages } from "./catalog/an.ts";
import { auMessages } from "./catalog/au.ts";
import { authMessages } from "./catalog/auth.ts";
import { benchMessages } from "./catalog/bench.ts";
import { chMessages } from "./catalog/ch.ts";
import { chatMessages } from "./catalog/chat.ts";
import { clMessages } from "./catalog/cl.ts";
import { commonMessages } from "./catalog/common.ts";
import { costMessages } from "./catalog/cost.ts";
import { csMessages } from "./catalog/cs.ts";
import { decMessages } from "./catalog/dec.ts";
import { handoffMessages } from "./catalog/handoff.ts";
import { igMessages } from "./catalog/ig.ts";
import { inMessages } from "./catalog/in.ts";
import { insMessages } from "./catalog/ins.ts";
import { invMessages } from "./catalog/inv.ts";
import { knMessages } from "./catalog/kn.ts";
import { kpMessages } from "./catalog/kp.ts";
import { miscMessages } from "./catalog/misc.ts";
import { officeMessages } from "./catalog/office.ts";
import { ovMessages } from "./catalog/ov.ts";
import { peMessages } from "./catalog/pe.ts";
import { qlMessages } from "./catalog/ql.ts";
import { qxMessages } from "./catalog/qx.ts";
import { repoMessages } from "./catalog/repo.ts";
import { rpMessages } from "./catalog/rp.ts";
import { runMessages } from "./catalog/run.ts";
import { runsMessages } from "./catalog/runs.ts";
import { rvMessages } from "./catalog/rv.ts";
import { setMessages } from "./catalog/set.ts";
import { siMessages } from "./catalog/si.ts";
import { srMessages } from "./catalog/sr.ts";
import { trMessages } from "./catalog/tr.ts";
import { traceMessages } from "./catalog/trace.ts";
import { tsMessages } from "./catalog/ts.ts";
import { wfeMessages } from "./catalog/wfe.ts";
import { wfsMessages } from "./catalog/wfs.ts";
import { wiMessages } from "./catalog/wi.ts";

const parts = [
  aeMessages,
  anMessages,
  auMessages,
  authMessages,
  benchMessages,
  chMessages,
  chatMessages,
  clMessages,
  commonMessages,
  costMessages,
  csMessages,
  decMessages,
  handoffMessages,
  igMessages,
  inMessages,
  insMessages,
  invMessages,
  knMessages,
  kpMessages,
  miscMessages,
  officeMessages,
  ovMessages,
  peMessages,
  qlMessages,
  qxMessages,
  repoMessages,
  rpMessages,
  runMessages,
  runsMessages,
  rvMessages,
  setMessages,
  siMessages,
  srMessages,
  trMessages,
  traceMessages,
  tsMessages,
  wfeMessages,
  wfsMessages,
  wiMessages,
];

/** The merged catalog: every namespace file's keys, per locale. */
export const catalog: Record<"vi" | "en", Record<string, string>> = {
  vi: Object.assign({}, ...parts.map((p) => p.vi)),
  en: Object.assign({}, ...parts.map((p) => p.en)),
};
