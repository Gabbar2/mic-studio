import { falProvider } from "./fal";
import { klingProvider } from "./kling";
import { MOCK_PREFIX, mockProvider } from "./mock";
import { ProviderError } from "./types";
import type { ProviderName, VideoProvider } from "./types";

export * from "./types";

const REGISTRY: Record<ProviderName, VideoProvider> = {
  kling: klingProvider,
  fal: falProvider,
  mock: mockProvider,
};

/**
 * Which provider new jobs go to. One env var, so switching from mock to fal to
 * official Kling is a restart, not a code change.
 */
export function activeProvider(): VideoProvider {
  const name = (process.env.PROVIDER ?? "kling") as ProviderName;
  const provider = REGISTRY[name];

  if (!provider) {
    throw new ProviderError(
      `Unknown PROVIDER "${name}". Use one of: kling, fal, mock.`,
      "kling",
    );
  }
  return provider;
}

/**
 * Resolves the provider for an *existing* job, which may not be the active one
 * — you can switch PROVIDER while jobs are still in flight, and those jobs must
 * keep polling the service that actually created them. Mock is matched by task
 * id prefix so mock jobs resolve even after you switch to a real provider.
 */
export function providerFor(name: string, taskId?: string): VideoProvider {
  if (taskId?.startsWith(MOCK_PREFIX)) return mockProvider;

  const provider = REGISTRY[name as ProviderName];
  if (!provider) {
    throw new ProviderError(`Unknown provider "${name}" on job`, "kling");
  }
  return provider;
}
