// Entry point for the prebuilt browser IIFE bundle. Assigns the default
// export to `globalThis.Mopidy` so that `<script>` tag consumers can access
// it as `window.Mopidy`.
import Mopidy from "./mopidy";

(globalThis as unknown as { Mopidy: typeof Mopidy }).Mopidy = Mopidy;

export default Mopidy;
