import { useState } from "react";
import { Home, Loader2, LocateFixed, MapPin } from "lucide-react";
import { get, post } from "../api";

const KEY = "tsl.places";

export interface Place { label: string; city: string; pincode?: string | null }

export function savedPlaces(): Place[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function rememberPlace(city: string, label = "Recent", pincode?: string | null) {
  if (!city.trim()) return;
  try {
    const list = savedPlaces().filter((p) => p.city.toLowerCase() !== city.toLowerCase() || (p.pincode || "") !== (pincode || ""));
    localStorage.setItem(KEY, JSON.stringify([{ label, city, pincode: pincode || null }, ...list].slice(0, 4)));
  } catch { /* ignore */ }
}

/** Delivery place: city + 6-digit PIN code. Type either (a PIN code fills in the city), use your
 *  current location (city and PIN code), or pick a saved place. */
export default function LocationField({
  value, onChange, pincode = "", onPincode, compact = false,
}: {
  value: string; onChange: (v: string) => void; pincode?: string; onPincode?: (p: string) => void; compact?: boolean;
}) {
  const [locating, setLocating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const places = savedPlaces();

  function locate() {
    if (!navigator.geolocation) return setErr("Location isn't available on this device.");
    setLocating(true);
    setErr(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const r = await post<{ label: string; pincode?: string | null; area?: string }>("/api/locate", { lat: pos.coords.latitude, lng: pos.coords.longitude });
          onChange(r.label);
          if (r.pincode) onPincode?.(r.pincode);
          setArea(r.area || null);
          rememberPlace(r.label, "Current", r.pincode);
        } catch {
          setErr("Couldn't find your place - type your PIN code instead.");
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setErr("Location permission was declined - type your PIN code instead.");
      },
      { timeout: 10000, maximumAge: 600000 },
    );
  }

  async function pin(p: string) {
    const v = p.replace(/\D/g, "").slice(0, 6);
    onPincode?.(v);
    setErr(null);
    if (v.length === 6) {
      try {
        const r = await get<{ label: string; areas: string[] }>(`/api/pincode/${v}`);
        if (!value || !value.toLowerCase().includes(r.label.split(",")[0].toLowerCase())) onChange(r.label);
        setArea(r.areas?.[0] || null);
      } catch {
        setErr("That PIN code wasn't found - check it.");
      }
    }
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="loc">
        <MapPin size={16} className="muted" />
        <input className="loc-input" data-pilot="city" placeholder="Deliver to (city)" value={value} onChange={(e) => onChange(e.target.value)}
          onBlur={() => rememberPlace(value, "Recent", pincode)} aria-label="Delivery city" />
        {onPincode && (
          <input className="loc-pin" data-pilot="pin" inputMode="numeric" placeholder="PIN code" value={pincode} onChange={(e) => pin(e.target.value)}
            aria-label="Delivery PIN code" maxLength={6} />
        )}
        <button className="btn sm ghost" type="button" onClick={locate} disabled={locating} title="Use my current location">
          {locating ? <Loader2 size={14} className="spin" /> : <LocateFixed size={14} />} {!compact && "Use my location"}
        </button>
      </div>
      {area && <div className="tiny muted">Area: {area}</div>}
      {places.length > 0 && (
        <div className="row wrap" style={{ gap: 6 }}>
          {places.map((p) => (
            <button key={p.city + (p.pincode || "")} type="button" className="chip clickable" onClick={() => { onChange(p.city); if (p.pincode) onPincode?.(p.pincode); }}>
              <Home /> {p.city}{p.pincode ? ` · ${p.pincode}` : ""}
            </button>
          ))}
        </div>
      )}
      {err && <div className="tiny muted">{err}</div>}
    </div>
  );
}
