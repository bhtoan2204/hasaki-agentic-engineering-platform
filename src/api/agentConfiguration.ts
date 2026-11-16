import { z } from "zod";
import { AGENT_PROVIDERS } from "../agent/provider.ts";
import {
  ProviderPatch,
  ROUTING_SCOPES,
  ROUTING_ROLES,
  previewAgentValues,
} from "../agent/configuration.ts";
import { providerControls } from "../agent/providerCapabilities.ts";
import { loadAgentConfiguration, saveProviderConfiguration } from "../agent/configurationStore.ts";

export async function agentConfigurationView() {
  return {
    document: await loadAgentConfiguration(),
    controls: providerControls,
    scopes: ROUTING_SCOPES,
    roles: ROUTING_ROLES,
  };
}
export async function patchAgentProvider(raw: unknown) {
  const input = z
    .object({
      provider: z.enum(AGENT_PROVIDERS),
      revision: z.number().int().nonnegative(),
      patch: ProviderPatch,
    })
    .strict()
    .parse(raw);
  await saveProviderConfiguration(input.provider, input.revision, input.patch);
  return agentConfigurationView();
}
export async function previewAgentConfiguration(raw: unknown) {
  const input = z
    .object({
      provider: z.enum(AGENT_PROVIDERS),
      scope: z.enum(ROUTING_SCOPES),
      role: z.enum(ROUTING_ROLES),
      draft: ProviderPatch.optional(),
    })
    .strict()
    .parse(raw);
  const document = await loadAgentConfiguration();
  return previewAgentValues(document, input.provider, input.scope, input.role, input.draft ?? {});
}
