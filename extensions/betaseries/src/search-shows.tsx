import { List } from "@raycast/api";
import { useState, useEffect } from "react";
import { searchShows } from "./api/client";
import { Show } from "./types/betaseries";
import { ShowListItem } from "./components/ShowListItem";

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const [items, setItems] = useState<Show[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function fetch() {
      if (searchText.length === 0) {
        setItems([]);
        return;
      }
      setIsLoading(true);
      try {
        const results = await searchShows(searchText);
        setItems(results);
      } catch (error) {
        console.error(error);
      } finally {
        setIsLoading(false);
      }
    }

    const delayDebounceFn = setTimeout(() => {
      fetch();
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [searchText]);

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search TV Shows..."
      throttle
    >
      {items.map((show) => (
        <ShowListItem key={show.id} show={show} />
      ))}
    </List>
  );
}
