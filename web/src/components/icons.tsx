import {
  Baby, Bike, Book, Box, Briefcase, Calendar, Car, Cpu, Dog, Droplet, Gift, Hash, Heart, Home, Lamp, Layers, Leaf, MapPin, Monitor, Package, Palette,
  Plug, Ruler, Scissors, Shield, Shirt, Smartphone, Sofa, Sparkles, Sun, Users, Utensils, Wallet, Weight, Wrench, Zap, type LucideIcon,
} from "lucide-react";
import type { Route } from "../types";

const MAP: Record<string, LucideIcon> = {
  ruler: Ruler, shirt: Shirt, cpu: Cpu, car: Car, gift: Gift, users: Users, calendar: Calendar, palette: Palette, box: Box, plug: Plug,
  weight: Weight, sparkles: Sparkles, home: Home, package: Package, scissors: Scissors, utensils: Utensils, heart: Heart, briefcase: Briefcase,
  baby: Baby, dog: Dog, bike: Bike, sofa: Sofa, lamp: Lamp, book: Book, phone: Smartphone, monitor: Monitor, layers: Layers, hash: Hash,
  "map-pin": MapPin, wallet: Wallet, leaf: Leaf, shield: Shield, wrench: Wrench, zap: Zap, droplet: Droplet, sun: Sun,
};

/** The icon Gemini picked for a fact or a kind of purchase (falls back to a sparkle). */
export function FacetIcon({ name, size = 14 }: { name?: string | null; size?: number }) {
  const I = (name && MAP[name]) || Sparkles;
  return <I size={size} />;
}

export const ROUTE_LABEL: Record<Route, string> = {
  buy: "Ready-made",
  make: "Made for you",
  either: "Buy or make",
  source: "Bulk sourcing",
};
