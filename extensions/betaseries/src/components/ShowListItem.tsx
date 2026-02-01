import {
  Action,
  ActionPanel,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { Show } from "../types/betaseries";
import { ShowEpisodesList } from "./ShowEpisodesList";
import { addShowToList } from "../api/client";
import { useState } from "react";

interface ShowListItemProps {
  show: Show;
  isMyShow?: boolean;
}

export function ShowListItem({ show, isMyShow = false }: ShowListItemProps) {
  const [isAdded, setIsAdded] = useState(show.in_account);

  const handleAddToList = async () => {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Adding show...",
      });
      await addShowToList(show.id);
      setIsAdded(true);
      await showToast({
        style: Toast.Style.Success,
        title: "Show added to your list",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to add show",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  // Prepare accessories based on whether this is "My Shows" or a search result
  const getAccessories = () => {
    if (isMyShow) {
      // For "My Shows", display unwatched episodes count
      const remaining = show.user?.remaining ?? 0;
      if (remaining === 0) {
        return [{ text: "All episodes watched" }, { icon: Icon.CheckCircle }];
      } else {
        return [
          { text: `${remaining} episode${remaining > 1 ? "s" : ""} to watch` },
        ];
      }
    } else {
      // For search results, display seasons and episodes
      return [
        { text: `${show.seasons} seasons` },
        { text: `${show.episodes} episodes` },
        { icon: isAdded ? Icon.CheckCircle : undefined },
      ];
    }
  };

  return (
    <List.Item
      title={show.title}
      subtitle={show.creation || ""}
      icon={show.images.poster || Icon.Video}
      accessories={getAccessories()}
      actions={
        <ActionPanel>
          {isMyShow ? (
            <>
              <Action.Push
                title="View Unwatched Episodes"
                icon={Icon.List}
                target={<ShowEpisodesList show={show} />}
              />
              <Action.OpenInBrowser
                url={show.resource_url}
                shortcut={{ modifiers: ["cmd"], key: "o" }}
              />
            </>
          ) : (
            <>
              {!isAdded && (
                <Action
                  title="Add to My Shows"
                  icon={Icon.Plus}
                  onAction={handleAddToList}
                />
              )}
              <Action.OpenInBrowser
                url={show.resource_url}
                shortcut={{ modifiers: ["cmd"], key: "o" }}
              />
            </>
          )}
        </ActionPanel>
      }
    />
  );
}
