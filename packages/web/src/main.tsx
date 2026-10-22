import { createRoot } from "react-dom/client";
import { Story } from "@lgtm/core";

const s = Story.parse({ id: "1", title: "Hello lgtm-review" });
createRoot(document.getElementById("root")!).render(<h1>{s.title}</h1>);
