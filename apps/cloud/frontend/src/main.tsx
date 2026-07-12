import { PostHogProvider } from "posthog-js/react";
import { AppRegistry } from "react-native";
import App from "./App";
import { posthog } from "./config/posthog";

// react-native-web bootstrap (mirrors apps/web): register the root component with
// AppRegistry and mount it into #root. The PostHogProvider makes the analytics client
// available to the tree via usePostHog(); importing ./config/posthog initializes it.
function Root() {
  return (
    <PostHogProvider client={posthog}>
      <App />
    </PostHogProvider>
  );
}

const rootTag = document.getElementById("root")!;
rootTag.innerHTML = "";
AppRegistry.registerComponent("CompanionCloud", () => Root);
AppRegistry.runApplication("CompanionCloud", { rootTag });
