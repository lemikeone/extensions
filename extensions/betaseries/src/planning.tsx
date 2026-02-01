import {
  Action,
  ActionPanel,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { useState, useEffect } from "react";
import { getPlanning, markEpisodeAsWatched } from "./api/client";
import { MemberPlanning } from "./types/betaseries";

export default function Command() {
  const [items, setItems] = useState<MemberPlanning[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);
      try {
        const results = await getPlanning();
        setItems(results);
      } catch (error) {
        console.error(error);
        if (error instanceof Error) {
          showToast({
            style: Toast.Style.Failure,
            title: "Failed to load planning",
            message: error.message,
          });
        }
      } finally {
        setIsLoading(false);
      }
    }
    fetch();
  }, []);

  const handleMarkAsWatched = async (id: number) => {
    try {
      await markEpisodeAsWatched(String(id));
      // Optimistic update
      setItems((prev) => prev.filter((item) => item.episode_id !== id));
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to mark as watched",
          message: error.message,
        });
      }
    }
  };

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter planning...">
      {items.map((item) => (
        <List.Item
          key={item.episode_id || Math.random()}
          title={item.show_title || "Unknown Show"}
          subtitle={`${item.code || `S${item.season}E${item.episode}`} - ${item.title || "Episode"}`}
          accessories={[{ text: item.date || "" }]}
          actions={
            <ActionPanel>
              <Action
                title="Mark as Watched"
                icon={Icon.CheckCircle}
                onAction={() => handleMarkAsWatched(item.episode_id)}
              />
              <Action.OpenInBrowser
                url={`https://www.betaseries.com/episode/${item.show_title}/${item.code}`}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
