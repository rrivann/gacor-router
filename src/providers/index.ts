// Provider wiring. Importing this module registers every built-in provider;
// the registry itself stays dumb.

import { registry } from "./registry";
import { CodeBuddyProvider } from "./codebuddy";

registry.register(new CodeBuddyProvider());

export { registry };
