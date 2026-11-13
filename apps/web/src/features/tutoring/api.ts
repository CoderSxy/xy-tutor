import { api, jsonBody } from "../../lib/api";
import type { TimingEventInput } from "../../../../../packages/contracts/src/learning-timing.js";
import type {
  EpisodeDTO,
  EpisodeStartInput,
} from "../../../../../packages/contracts/src/tutoring.js";

export type TimingApi = {
  start(input: EpisodeStartInput): Promise<EpisodeDTO>;
  append(episodeId: string, events: TimingEventInput[]): Promise<EpisodeDTO>;
  get(episodeId: string): Promise<EpisodeDTO>;
};

export function createTimingApi(scoped: (path: string) => string): TimingApi {
  return {
    start: (input) =>
      api<EpisodeDTO>(scoped("/api/tutoring/episodes"), {
        method: "POST",
        ...jsonBody(input),
      }),
    append: (episodeId, events) =>
      api<EpisodeDTO>(
        scoped(`/api/tutoring/episodes/${encodeURIComponent(episodeId)}/events`),
        { method: "POST", ...jsonBody({ events }) },
      ),
    get: (episodeId) =>
      api<EpisodeDTO>(
        scoped(`/api/tutoring/episodes/${encodeURIComponent(episodeId)}`),
      ),
  };
}
