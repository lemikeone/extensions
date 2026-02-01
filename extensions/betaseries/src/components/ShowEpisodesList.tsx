import { List, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { getUnwatchedEpisodes, markEpisodeAsWatched } from "../api/client";
import { Show, Episode } from "../types/betaseries";
import { EpisodeListItem } from "./EpisodeListItem";

interface ShowEpisodesListProps {
  show: Show;
}

export function ShowEpisodesList({ show }: ShowEpisodesListProps) {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchEpisodes() {
      setIsLoading(true);
      try {
        const results = await getUnwatchedEpisodes(show.id);
        // Ensure results is an array
        setEpisodes(Array.isArray(results) ? results : []);
      } catch (error) {
        console.error(error);
        setEpisodes([]); // Reset to empty array on error
        if (error instanceof Error) {
          showToast({
            style: Toast.Style.Failure,
            title: "Failed to load episodes",
            message: error.message,
          });
        }
      } finally {
        setIsLoading(false);
      }
    }
    fetchEpisodes();
  }, [show.id]);

  const handleMarkAsWatched = async (episodeId: number) => {
    try {
      await markEpisodeAsWatched(String(episodeId));
      showToast({
        style: Toast.Style.Success,
        title: "Episode marked as watched",
      });
      // Refresh the list
      setEpisodes((prev) =>
        prev.map((ep) =>
          ep.id === episodeId
            ? { ...ep, user: { ...ep.user, seen: true } }
            : ep,
        ),
      );
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to mark episode as watched",
          message: error.message,
        });
      }
    }
  };

  return (
    <List isLoading={isLoading} navigationTitle={show.title}>
      {!isLoading && episodes.length === 0 && (
        <List.EmptyView
          title="No Unwatched Episodes"
          description="You're all caught up!"
        />
      )}
      {episodes.map((episode) => (
        <EpisodeListItem
          key={episode.id}
          episode={episode}
          onMarkAsWatched={handleMarkAsWatched}
        />
      ))}
    </List>
  );
}
