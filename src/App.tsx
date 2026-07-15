import { useCallback, useEffect, useState } from "react";
import { supabase, type ClothingItem, type SavedOutfit } from "./lib/supabase";
import { WardrobeView } from "./components/WardrobeView";
import { OutfitsView } from "./components/OutfitsView";
import { AuthView } from "./components/AuthView";
import { Shirt, Sparkles, Camera, LogOut, Loader2 } from "lucide-react";
import type { Session } from "@supabase/supabase-js";

type Tab = "wardrobe" | "outfits";

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [tab, setTab] = useState<Tab>("wardrobe");
  const [items, setItems] = useState<ClothingItem[]>([]);
  const [savedOutfits, setSavedOutfits] = useState<SavedOutfit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data }) => {
        setSession(data.session);
      })
      .catch((err) => {
        console.error("Failed to get session:", err);
      })
      .finally(() => {
        setAuthReady(true);
      });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from("clothing_items")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("Error fetching items:", error.message);
    }
    setItems(data || []);
    setLoading(false);
  }, []);

  const fetchSavedOutfits = useCallback(async () => {
    const { data, error } = await supabase
      .from("saved_outfits")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("Error fetching saved outfits:", error.message);
    }
    setSavedOutfits(data || []);
  }, []);

  useEffect(() => {
    if (session) {
      fetchItems();
      fetchSavedOutfits();
    } else {
      setItems([]);
      setSavedOutfits([]);
      setLoading(false);
    }
  }, [session, fetchItems, fetchSavedOutfits]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-50">
        <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
      </div>
    );
  }

  if (!session) {
    return <AuthView />;
  }

  const itemCount = items.length;
  const comboCount = savedOutfits.length;

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-stone-200 bg-stone-50/80 backdrop-blur-lg">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-stone-900 text-white">
                <Shirt className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">FitForge</h1>
                <p className="text-xs text-stone-500 -mt-0.5">AI-powered outfit stylist</p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="hidden sm:flex items-center gap-1.5 text-stone-600">
                <Camera className="h-4 w-4" />
                {itemCount} {itemCount === 1 ? "item" : "items"}
              </span>
              <span className="hidden sm:flex items-center gap-1.5 text-stone-600">
                <Sparkles className="h-4 w-4" />
                {comboCount} {comboCount === 1 ? "outfit" : "outfits"}
              </span>
              <button
                onClick={handleSignOut}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-200"
                title="Sign out"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="mx-auto max-w-6xl px-4 sm:px-6 pt-4">
        <div className="flex gap-1 rounded-xl bg-stone-200/60 p-1 w-full max-w-xs">
          <button
            onClick={() => setTab("wardrobe")}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
              tab === "wardrobe"
                ? "bg-white text-stone-900 shadow-sm"
                : "text-stone-600 hover:text-stone-900"
            }`}
          >
            My Wardrobe
          </button>
          <button
            onClick={() => setTab("outfits")}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
              tab === "outfits"
                ? "bg-white text-stone-900 shadow-sm"
                : "text-stone-600 hover:text-stone-900"
            }`}
          >
            Outfits
          </button>
        </div>
      </div>

      {/* Main Content */}
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-6 pb-24">
        {tab === "wardrobe" ? (
          <WardrobeView items={items} loading={loading} onChanged={fetchItems} />
        ) : (
          <OutfitsView items={items} savedOutfits={savedOutfits} onSavedChanged={fetchSavedOutfits} />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-stone-200 py-6">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 text-center text-xs text-stone-400">
          FitForge — Drop your clothes, get styled. Your AI wardrobe stylist.
        </div>
      </footer>
    </div>
  );
}

export default App;
