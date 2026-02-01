import { getPreferenceValues } from "@raycast/api";
// Remove this import - fetch is globally available
import { URLSearchParams } from "url";
import {
  BetaSeriesResponse,
  Show,
  Movie,
  Episode,
  MemberPlanning,
} from "../types/betaseries";

const BASE_URL = "https://api.betaseries.com";

interface Preferences {
  apiKey: string;
  token?: string;
}

const getHeaders = () => {
  const { apiKey, token } = getPreferenceValues<Preferences>();
  const headers: Record<string, string> = {
    "X-BetaSeries-Key": apiKey,
    "X-BetaSeries-Version": "3.0",
    "Content-Type": "application/json",
  };
  if (token) {
    headers["X-BetaSeries-Token"] = token;
  }
  return headers;
};

async function fetchBetaSeries<T>(
  endpoint: string,
  params: Record<string, string> = {},
  method: string = "GET",
): Promise<T> {
  const url = new URL(`${BASE_URL}${endpoint}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchOptions: any = {
    method,
    headers: getHeaders(),
  };

  if (method === "GET") {
    const searchParams = new URLSearchParams(params);
    url.search = searchParams.toString();
  } else {
    // For POST, PUT, DELETE, send params in body as form data
    const formData = new URLSearchParams(params);
    fetchOptions.body = formData.toString();
    fetchOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Unauthorized. Please check your BetaSeries Token in extension preferences.",
      );
    }

    // Try to parse error details from response
    let errorData: { errors?: { text: string; code?: number }[] } | null = null;
    try {
      errorData = (await response.json()) as {
        errors?: { text: string; code?: number }[];
      };
    } catch {
      // JSON parse failed, we'll use generic error below
    }

    if (errorData?.errors && errorData.errors.length > 0) {
      const errorText = errorData.errors[0].text;
      if (
        errorText.includes(`paramètre "id" est manquant`) ||
        errorText.includes('parameter "id" is missing')
      ) {
        throw new Error(
          "Invalid Token. You may have entered the API Key instead of the OAuth Token, or the token is expired.",
        );
      }
      throw new Error(`BetaSeries Error: ${errorText}`);
    }

    throw new Error(
      `BetaSeries API Error: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as BetaSeriesResponse<T>;
  return data as T;
}

export async function searchShows(title: string): Promise<Show[]> {
  const data = await fetchBetaSeries<{ shows: Show[] }>("/shows/search", {
    title,
  });
  return data.shows;
}

export async function searchMovies(title: string): Promise<Movie[]> {
  const data = await fetchBetaSeries<{ movies: Movie[] }>("/movies/search", {
    title,
  });
  return data.movies;
}

export async function getMyShows(status?: string): Promise<Show[]> {
  // status: active, archived, etc.
  // /shows/member
  const { token } = getPreferenceValues<Preferences>();
  if (!token) {
    throw new Error(
      "This command requires a BetaSeries Token. Please add it in the extension preferences.",
    );
  }
  const params: Record<string, string> = { limit: "100" };
  if (status) params.status = status;

  const data = await fetchBetaSeries<{ shows: Show[] }>(
    "/shows/member",
    params,
  );
  return data.shows;
}

export async function getMyMovies(state?: number): Promise<Movie[]> {
  // state: 0 = to watch, 1 = watched
  const { token } = getPreferenceValues<Preferences>();
  if (!token) {
    throw new Error(
      "This command requires a BetaSeries Token. Please add it in the extension preferences.",
    );
  }
  const params: Record<string, string> = { limit: "100" };
  if (state !== undefined) params.state = String(state);

  const data = await fetchBetaSeries<{ movies: Movie[] }>(
    "/movies/member",
    params,
  );
  return data.movies;
}

export async function getPlanning(): Promise<MemberPlanning[]> {
  const { token } = getPreferenceValues<Preferences>();
  if (!token) {
    throw new Error(
      "This command requires a BetaSeries Token. Please add it in the extension preferences.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await fetchBetaSeries<any>("/planning/member");
  const response = await fetchBetaSeries<any>("/planning/member");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawItems: any[] = [];

  // Try different response structures
  if (Array.isArray(response)) {
    rawItems = response;
  } else if (response.planning && Array.isArray(response.planning)) {
    rawItems = response.planning;
  } else if (response.episodes && Array.isArray(response.episodes)) {
    rawItems = response.episodes;
  } else {
    console.log("Unexpected planning response structure:", response);
    return [];
  }

  // Transform the items to match our MemberPlanning interface
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rawItems.map((item: any) => ({
    date: item.date || "",
    episode_id: item.id || item.episode_id || 0,
    show_id: item.show?.id || item.show_id || 0,
    show_title: item.show?.title || item.show_title || "Unknown Show",
    season: item.season || 0,
    episode: item.episode || 0,
    title: item.title || "",
    code: item.code || `S${item.season || 0}E${item.episode || 0}`,
  }));
}

export async function getUnwatchedEpisodes(showId: number): Promise<Episode[]> {
  const { token } = getPreferenceValues<Preferences>();
  if (!token) {
    throw new Error(
      "This command requires a BetaSeries Token. Please add it in the extension preferences.",
    );
  }
  const data = await fetchBetaSeries<{ shows: Array<{ unseen: Episode[] }> }>(
    "/episodes/list",
    { showId: String(showId) },
  );
  console.log(
    "API Response for showId",
    showId,
    ":",
    JSON.stringify(data, null, 2),
  );
  // Extract episodes from shows[0].unseen
  return data.shows && data.shows.length > 0 && data.shows[0].unseen
    ? data.shows[0].unseen
    : [];
}

export async function markEpisodeAsWatched(
  id: string,
  bulk: boolean = false,
): Promise<void> {
  await fetchBetaSeries(
    "/episodes/watched",
    { id, bulk: bulk ? "true" : "false" },
    "POST",
  );
}

export async function getMovieDetails(id: number): Promise<Movie> {
  const data = await fetchBetaSeries<{ movie: Movie }>("/movies/movie", {
    id: String(id),
  });
  return data.movie;
}

export async function markMovieAsWatched(id: number): Promise<void> {
  await fetchBetaSeries(
    "/movies/movie",
    { id: String(id), state: "1" },
    "POST",
  );
}

export async function markMovieAsUnwatched(id: number): Promise<void> {
  await fetchBetaSeries(
    "/movies/movie",
    { id: String(id), state: "0" },
    "POST",
  );
}

export async function rateMovie(id: number, rating: number): Promise<void> {
  await fetchBetaSeries(
    "/movies/note",
    { id: String(id), note: String(rating) },
    "POST",
  );
}

export async function addMovieToList(id: number): Promise<void> {
  // state: 0 = to watch (default)
  await fetchBetaSeries(
    "/movies/movie",
    { id: String(id), state: "0" },
    "POST",
  );
}

export async function addShowToList(id: number): Promise<void> {
  await fetchBetaSeries("/shows/show", { id: String(id) }, "POST");
}
