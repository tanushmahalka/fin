import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { queryClient } from "./api";
import { EntityShell } from "./components/Shell";
import { ToastProvider } from "./components/ui";
import { AccountDetailPage, AccountsPage } from "./pages/Accounts";
import { Home, InviteAccept, Login, NewEntity, RequireAuth, Setup } from "./pages/Auth";
import { BudgetPage } from "./pages/Budget";
import { ContactDetailPage, ContactsPage } from "./pages/Contacts";
import { DevicePage } from "./pages/Device";
import { ImportsPage } from "./pages/Imports";
import { ProfilePage } from "./pages/Profile";
import { EmisPage } from "./pages/Emis";
import { FlaggedPage } from "./pages/Flagged";
import { SubscriptionsPage } from "./pages/Subscriptions";
import { SettingsPage } from "./pages/Settings";
import { StatsPage } from "./pages/Stats";
import { TransactionsPage } from "./pages/Transactions";
import "./styles.css";

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/setup", element: <Setup /> },
  { path: "/invite/:token", element: <InviteAccept /> },
  {
    element: <RequireAuth />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/new", element: <NewEntity /> },
      { path: "/device", element: <DevicePage /> },
      {
        path: "/e/:entityId",
        element: <EntityShell />,
        children: [
          { index: true, element: <Navigate to="transactions" replace /> },
          { path: "transactions", element: <TransactionsPage /> },
          { path: "stats", element: <StatsPage /> },
          { path: "accounts", element: <AccountsPage /> },
          { path: "accounts/:accountId", element: <AccountDetailPage /> },
          { path: "emis", element: <EmisPage /> },
          { path: "subscriptions", element: <SubscriptionsPage /> },
          { path: "contacts", element: <ContactsPage /> },
          { path: "contacts/:contactId", element: <ContactDetailPage /> },
          { path: "budget", element: <BudgetPage /> },
          { path: "imports", element: <ImportsPage /> },
          { path: "flagged", element: <FlaggedPage /> },
          { path: "settings", element: <SettingsPage /> },
          { path: "profile", element: <ProfilePage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
