import { useState } from "react";
import { Home, Loader2, LocateFixed, MapPin } from "lucide-react";
import { post } from "../api";

const KEY = "tsl.places";

export function savedPlaces(): { label: string; city: string }[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function rememberPlace(city: string, label = "Recent") {
  if (!city.trim()) return;
  try {
    const list = savedPlaces().filter((p) => p.city.toLowerCase() !== city.toLowerCase());
    localStorage.setItem(KEY, JSON.stringify([{ label, city }, ...list].slice(0, 4)));
  } catch { /* ignore */ }
}

/** Delivery location: type it, use your current location, or pick a saved place. */
export default function LocationField({ value, onChange, compact = false }: { value: string; onChange: (v: string) => void; compact?: boolean }) {
  const [locating, setLocating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const places = savedPlaces();

  function locate() {
    if (!navigator.geolocation) return setErr("Location isn't available on this device.");
    setLocating(true);
    setErr(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const r = await post<{ label: string }>("/api/locate", { lat: pos.coords.latitude, lng: pos.coords.longitude });
          onChange(r.label);
          rememberPlace(r.label, "Current");
        } catch {
          setErr("Couldn't find your city - type it instead.");
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setErr("Location permission was declined - type your city instead.");
      },
      { timeout: 10000, maximumAge: 600000 },
    );
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="loc">
        <MapPin size={16} className="muted" />
        <input className="loc-input" data-pilot="city" placeholder="Deliver to (city)" value={value} onChange={(e) => onChange(e.target.value)}
          onBlur={() => rememberPlace(value)} aria-label="Delivery city" />
        <button className="btn sm ghost" type="button" onClick={locate} disabled={locating} title="Use my current location">
          {locating ? <Loader2 size={14} className="spin" /> : <LocateFixed size={14} />} {!compact && "Use my location"}
        </button>
      </div>
      {places.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {places.map((p) => (
            <button key={p.city} type="button" className="chip clickable" onClick={() => onChange(p.city)}>
              <Home /> {p.city}
            </button>
          ))}
        </div>
      )}
      {err && <div className="tiny muted">{err}</div>}
    </div>
  );
}
