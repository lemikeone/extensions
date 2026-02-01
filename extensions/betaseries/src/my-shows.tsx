import { List, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { getMyShows } from "./api/client";
import { Show } from "./types/betaseries";
import { ShowListItem } from "./components/ShowListItem";

export default function Command() {
  const [items, setItems] = useState<Show[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState("active"); // active, archived

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);
      try {
        const results = await getMyShows(
          filter === "active" ? "current" : "archived",
        );
        setItems(results);
      } catch (error) {
        console.error(error);
        if (error instanceof Error) {
          showToast({
            style: Toast.Style.Failure,
            title: "Failed to load shows",
            message: error.message,
          });
        }
      } finally {
        setIsLoading(false);
      }
    }
    fetch();
  }, [filter]);

  return (
    <List
      isLoading={isLoading}
      searchBarAccessory={
        <List.Dropdown tooltip="Filter" storeValue={true} onChange={setFilter}>
          <List.Dropdown.Item title="Active" value="active" />
          <List.Dropdown.Item title="Archived" value="archived" />
        </List.Dropdown>
      }
    >
      {items.map((show) => (
        <ShowListItem key={show.id} show={show} isMyShow />
      ))}
    </List>
  );
}
