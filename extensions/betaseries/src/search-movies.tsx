import { List } from "@raycast/api";
import { useState, useEffect } from "react";
import { searchMovies } from "./api/client";
import { Movie } from "./types/betaseries";
import { MovieListItem } from "./components/MovieListItem";

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const [items, setItems] = useState<Movie[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    async function fetch() {
      if (searchText.length === 0) {
        setItems([]);
        return;
      }
      setIsLoading(true);
      try {
        const results = await searchMovies(searchText);
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
      searchBarPlaceholder="Search Movies..."
      throttle
    >
      {items.map((movie) => (
        <MovieListItem key={movie.id} movie={movie} />
      ))}
    </List>
  );
}
