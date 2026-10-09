import { Home } from "./pages/Home";
import { Room } from "./pages/Room";

/** Two routes only, so no router library: `/` and `/room/:roomId`. */
export function App() {
	const match = window.location.pathname.match(/^\/room\/([^/]+)\/?$/);
	if (match?.[1]) return <Room roomId={decodeURIComponent(match[1])} />;
	return <Home />;
}
