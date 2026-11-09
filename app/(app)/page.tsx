import { Placeholder } from '@/src/screens/Placeholder';

export const metadata = { title: 'Home' };

export default function Page() {
  return (
    <Placeholder
      icon="house"
      heading="Home"
      description="Your latest check-ins and a summary of where you have been will be here."
    />
  );
}
