import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import Layout from "./components/layout/Layout";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import Requests from "./pages/Requests";
import Models from "./pages/Models";
import Settings from "./pages/Settings";
import Tunnel from "./pages/Tunnel";

// Chat pulls in react-syntax-highlighter (~280KB gzip) — lazy-load it so the
// main bundle stays lean and the highlighter only downloads on /chat.
const Chat = lazy(() => import("./pages/Chat"));

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route
          path="chat"
          element={
            <Suspense fallback={<div className="flex h-screen items-center justify-center text-muted-foreground">Loading chat…</div>}>
              <Chat />
            </Suspense>
          }
        />
        <Route path="accounts" element={<Accounts />} />
        <Route path="requests" element={<Requests />} />
        <Route path="models" element={<Models />} />
        <Route path="tunnel" element={<Tunnel />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
