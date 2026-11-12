import { Placeholder } from './Placeholder';

/** Home (DESIGN.md §20.4), which is the front address `/` for someone signed in. The summary and the latest check-ins are 7.6. The server's page and the offline shell draw this one. */
export function HomeScreen() {
  return (
    <Placeholder
      icon="house"
      heading="Home"
      description="Your latest check-ins and a summary of where you have been will be here."
    />
  );
}
