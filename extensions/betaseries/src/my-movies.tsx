import { List, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { getMyMovies } from "./api/client";
import { Movie } from "./types/betaseries";
import { MovieListItem } from "./components/MovieListItem";

export default function Command() {
  const [items, setItems] = useState<Movie[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState("0"); // 0 = To Watch, 1 = Watched

  useEffect(() => {
    async function fetch() {
      setIsLoading(true);
      try {
        const results = await getMyMovies(parseInt(filter));
        setItems(results);
      } catch (error) {
        console.error(error);
        if (error instanceof Error) {
          showToast({
            style: Toast.Style.Failure,
            title: "Failed to load movies",
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
          <List.Dropdown.Item title="To Watch" value="0" />
          <List.Dropdown.Item title="Watched" value="1" />
        </List.Dropdown>
      }
    >
      {items.map((movie) => (
        <MovieListItem key={movie.id} movie={movie} isMyMovie={true} />
      ))}
    </List>
  );
}
