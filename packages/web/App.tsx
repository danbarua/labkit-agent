import { DesignBoard } from "./components/brand/design-board.tsx";
import { Console } from "./console/Console.tsx";

import "./index.css";

export function App() {
  if (window.location.pathname === "/brand") return <DesignBoard />;
  return <Console />;
}

export default App;
