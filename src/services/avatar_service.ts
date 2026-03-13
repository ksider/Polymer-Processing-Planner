export type AvatarStyle = {
  palette: "amber" | "ocean" | "rose" | "mint" | "violet";
  presentation: "neutral" | "feminine" | "masculine";
  skinTone: "fair" | "warm" | "olive" | "brown" | "deep";
  hair: "short" | "round" | "spiky";
  accessory: "none" | "glasses";
  facialHair: "none" | "mustache";
  eyes: "calm" | "happy" | "wink";
  mouth: "default" | "smile" | "twinkle";
};

type AvatarUser = {
  id: number;
  name: string | null;
  email: string;
  avatar_style_json: string | null;
};

type DiceBearPalette = {
  background: string;
  clothes: string;
  hat: string;
  accessory: string;
  hair: string;
  facialHair: string;
};

const DICEBEAR_BASE_URL = "https://api.dicebear.com/9.x/avataaars/svg";

const PALETTES: Record<AvatarStyle["palette"], DiceBearPalette> = {
  amber: {
    background: "f2c572",
    clothes: "9c6235",
    hat: "b37645",
    accessory: "4b3c33",
    hair: "6b4327",
    facialHair: "7c5131"
  },
  ocean: {
    background: "89d0ee",
    clothes: "2f769d",
    hat: "4d94bf",
    accessory: "365168",
    hair: "2a3644",
    facialHair: "32485e"
  },
  rose: {
    background: "edb2c0",
    clothes: "cc5e82",
    hat: "da7899",
    accessory: "5e4150",
    hair: "57313b",
    facialHair: "704452"
  },
  mint: {
    background: "b8e6d3",
    clothes: "328e68",
    hat: "5fb08d",
    accessory: "36564a",
    hair: "294235",
    facialHair: "345446"
  },
  violet: {
    background: "cdc0fb",
    clothes: "6f5ad0",
    hat: "8d79ea",
    accessory: "493f6b",
    hair: "3c315c",
    facialHair: "56477f"
  }
};

const SKIN_TONES: Record<AvatarStyle["skinTone"], string> = {
  fair: "f2d3b1",
  warm: "e8b37e",
  olive: "c68655",
  brown: "8d5524",
  deep: "5c3836"
};

const HAIR_VARIANTS: Record<AvatarStyle["presentation"], Record<AvatarStyle["hair"], string[]>> = {
  neutral: {
    short: ["shortFlat", "sides"],
    round: ["shortRound", "shortCurly"],
    spiky: ["theCaesar", "theCaesarAndSidePart"]
  },
  feminine: {
    short: ["bob", "straight01"],
    round: ["curly", "bun"],
    spiky: ["shavedSides", "hijab"]
  },
  masculine: {
    short: ["shortFlat", "sides"],
    round: ["shortRound", "shortWaved"],
    spiky: ["theCaesar", "theCaesarAndSidePart"]
  }
};

const EYE_VARIANTS: Record<AvatarStyle["eyes"], string[]> = {
  calm: ["default", "side", "squint"],
  happy: ["happy", "hearts", "xDizzy"],
  wink: ["wink", "winkWacky"]
};

const MOUTH_VARIANTS: Record<AvatarStyle["mouth"], string[]> = {
  default: ["default", "serious"],
  smile: ["smile", "default"],
  twinkle: ["twinkle", "tongue"]
};

export const AVATAR_STYLE_OPTIONS = {
  palette: ["amber", "ocean", "rose", "mint", "violet"],
  presentation: ["neutral", "feminine", "masculine"],
  skinTone: ["fair", "warm", "olive", "brown", "deep"],
  hair: ["short", "round", "spiky"],
  accessory: ["none", "glasses"],
  facialHair: ["none", "mustache"],
  eyes: ["calm", "happy", "wink"],
  mouth: ["default", "smile", "twinkle"]
} as const;

function clampIndex(value: number, length: number) {
  return Math.abs(value) % length;
}

function hashSeed(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function parseStoredStyle(raw: string | null, seedHash: number): AvatarStyle {
  let parsed = {} as Partial<AvatarStyle>;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<AvatarStyle>;
    } catch {
      parsed = {};
    }
  }

  const palette = AVATAR_STYLE_OPTIONS.palette.includes(parsed.palette as AvatarStyle["palette"])
    ? (parsed.palette as AvatarStyle["palette"])
    : AVATAR_STYLE_OPTIONS.palette[clampIndex(seedHash, AVATAR_STYLE_OPTIONS.palette.length)];
  const presentation = AVATAR_STYLE_OPTIONS.presentation.includes(
    parsed.presentation as AvatarStyle["presentation"]
  )
    ? (parsed.presentation as AvatarStyle["presentation"])
    : AVATAR_STYLE_OPTIONS.presentation[clampIndex(seedHash >> 1, AVATAR_STYLE_OPTIONS.presentation.length)];
  const skinTone = AVATAR_STYLE_OPTIONS.skinTone.includes(parsed.skinTone as AvatarStyle["skinTone"])
    ? (parsed.skinTone as AvatarStyle["skinTone"])
    : AVATAR_STYLE_OPTIONS.skinTone[clampIndex(seedHash >> 2, AVATAR_STYLE_OPTIONS.skinTone.length)];
  const hair = AVATAR_STYLE_OPTIONS.hair.includes(parsed.hair as AvatarStyle["hair"])
    ? (parsed.hair as AvatarStyle["hair"])
    : AVATAR_STYLE_OPTIONS.hair[clampIndex(seedHash >> 3, AVATAR_STYLE_OPTIONS.hair.length)];
  const accessory = AVATAR_STYLE_OPTIONS.accessory.includes(parsed.accessory as AvatarStyle["accessory"])
    ? (parsed.accessory as AvatarStyle["accessory"])
    : AVATAR_STYLE_OPTIONS.accessory[clampIndex(seedHash >> 5, AVATAR_STYLE_OPTIONS.accessory.length)];
  const facialHair = AVATAR_STYLE_OPTIONS.facialHair.includes(parsed.facialHair as AvatarStyle["facialHair"])
    ? (parsed.facialHair as AvatarStyle["facialHair"])
    : AVATAR_STYLE_OPTIONS.facialHair[clampIndex(seedHash >> 7, AVATAR_STYLE_OPTIONS.facialHair.length)];
  const eyes = AVATAR_STYLE_OPTIONS.eyes.includes(parsed.eyes as AvatarStyle["eyes"])
    ? (parsed.eyes as AvatarStyle["eyes"])
    : AVATAR_STYLE_OPTIONS.eyes[clampIndex(seedHash >> 9, AVATAR_STYLE_OPTIONS.eyes.length)];
  const mouth = AVATAR_STYLE_OPTIONS.mouth.includes(parsed.mouth as AvatarStyle["mouth"])
    ? (parsed.mouth as AvatarStyle["mouth"])
    : AVATAR_STYLE_OPTIONS.mouth[clampIndex(seedHash >> 11, AVATAR_STYLE_OPTIONS.mouth.length)];

  return { palette, presentation, skinTone, hair, accessory, facialHair, eyes, mouth };
}

function buildUserSeed(user: Pick<AvatarUser, "id" | "email" | "name">) {
  return `${user.id}:${user.email.trim().toLowerCase()}:${user.name?.trim() ?? ""}`;
}

function setListParam(params: URLSearchParams, key: string, values: string[]) {
  params.set(key, values.join(","));
}

export function stringifyAvatarStyle(style: AvatarStyle) {
  return JSON.stringify(style);
}

export function normalizeAvatarStyle(style: Partial<AvatarStyle> | null | undefined, fallbackSeed: string) {
  return parseStoredStyle(style ? JSON.stringify(style) : null, hashSeed(fallbackSeed));
}

export function getAvatarStyle(user: AvatarUser) {
  return parseStoredStyle(user.avatar_style_json ?? null, hashSeed(buildUserSeed(user)));
}

export function buildAvatarRedirectUrl(user: AvatarUser, overrideStyle?: AvatarStyle) {
  const style = overrideStyle ?? getAvatarStyle(user);
  const palette = PALETTES[style.palette];
  const params = new URLSearchParams();

  params.set("seed", buildUserSeed(user));
  params.set("size", "128");
  params.set("radius", "24");
  params.set("style", "circle");
  params.set("backgroundType", "solid");
  params.set("backgroundColor", palette.background);
  params.set("skinColor", SKIN_TONES[style.skinTone]);
  params.set("clothesColor", palette.clothes);
  params.set("hatColor", palette.hat);
  params.set("hairColor", palette.hair);
  params.set("facialHairColor", palette.facialHair);
  params.set("accessoriesColor", palette.accessory);
  setListParam(
    params,
    "clothing",
    style.presentation === "feminine"
      ? ["blazerAndShirt", "graphicShirt", "shirtScoopNeck"]
      : ["hoodie", "shirtCrewNeck", "shirtVNeck", "blazerAndSweater"]
  );
  setListParam(params, "mouth", MOUTH_VARIANTS[style.mouth]);
  setListParam(params, "eyes", EYE_VARIANTS[style.eyes]);
  setListParam(
    params,
    "eyebrows",
    style.presentation === "feminine"
      ? ["defaultNatural", "raisedExcitedNatural"]
      : ["default", "defaultNatural", "upDown"]
  );
  setListParam(params, "top", HAIR_VARIANTS[style.presentation][style.hair]);

  if (style.accessory === "glasses") {
    params.set("accessoriesProbability", "100");
    setListParam(params, "accessories", ["round", "prescription02", "wayfarers"]);
  } else {
    params.set("accessoriesProbability", "0");
  }

  if (style.facialHair === "mustache") {
    params.set("facialHairProbability", "100");
    setListParam(params, "facialHair", ["moustacheFancy", "moustacheMagnum"]);
  } else {
    params.set("facialHairProbability", "0");
  }

  return `${DICEBEAR_BASE_URL}?${params.toString()}`;
}
