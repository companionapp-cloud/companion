import { AppRegistry } from "react-native";
import App from "./App";

// react-native-web bootstrap (mirrors apps/web): register the root component with
// AppRegistry and mount it into #root.
const rootTag = document.getElementById("root")!;
rootTag.innerHTML = "";
AppRegistry.registerComponent("CompanionCloud", () => App);
AppRegistry.runApplication("CompanionCloud", { rootTag });
