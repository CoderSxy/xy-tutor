import type { CapabilityReport } from "../../../../packages/contracts/src/agent.js";
import type { ModelGateway } from "./provider.js";
export function modelSupportsImages(gateway?: ModelGateway): boolean {
  return !!gateway?.runtime.model.input.includes("image");
}
export function configuredCapabilities(
  gateway?: ModelGateway,
): CapabilityReport {
  return {
    configured: !!gateway,
    streaming: "unverified",
    tools: "unverified",
    images: modelSupportsImages(gateway) ? "enabled-unverified" : "disabled",
    cancellation: "unverified",
  };
}
