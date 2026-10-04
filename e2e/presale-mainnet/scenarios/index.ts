import { e010 } from "./e010.ts";
import { e011 } from "./e011.ts";
import { e012 } from "./e012.ts";
import { e013 } from "./e013.ts";
import { e014 } from "./e014.ts";
import { e015 } from "./e015.ts";
import { e016 } from "./e016.ts";
import { e017 } from "./e017.ts";
import { e018 } from "./e018.ts";
import { e019 } from "./e019.ts";
import { e020 } from "./e020.ts";
import { e022 } from "./e022.ts";
import { e024 } from "./e024.ts";
import { e027 } from "./e027.ts";
import { e028 } from "./e028.ts";
import { e029 } from "./e029.ts";
import { e030 } from "./e030.ts";
import { setup } from "./setup.ts";

export const scenarios: Record<string, (phase?: string) => Promise<void>> = {
  setup,
  e010,
  e011,
  e012,
  e013,
  e014,
  e015,
  e016,
  e018,
  e019,
  e020,
  e022,
  e024,
  e027,
  e028,
  e029,
  e030,
  e017,
};
