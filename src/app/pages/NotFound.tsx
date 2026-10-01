import { Link } from '../router';

export default function NotFound({ message = 'There is nothing at this address.' }: { message?: string }) {
  return (
    <section className="page-head">
      <h1>Not found</h1>
      <p className="desc">{message}</p>
      <p>
        <Link href="/">See all data apps</Link>
      </p>
    </section>
  );
}
