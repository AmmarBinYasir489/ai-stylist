# AI-Powered Outfit Stylist 👔✨

An AI-powered wardrobe management application that helps users organize their clothing and receive intelligent outfit recommendations.

## Features

* 👕 Upload and manage your wardrobe
* 🤖 AI-powered clothing analysis
* 🎨 Automatic detection of clothing category, colors, and style
* 👤 Mannequin-based outfit visualization
* ✨ Background removal for uploaded clothing images
* 🧠 Smart outfit recommendations with AI reasoning
* ❤️ Save favorite outfits
* 🔐 Secure authentication with Supabase
* ☁️ Cloud image storage using Supabase Storage

## Tech Stack

### Frontend

* React
* TypeScript
* Vite
* Tailwind CSS

### Backend

* Supabase

  * Authentication
  * PostgreSQL Database
  * Storage
  * Edge Functions

### AI

* Vision AI for clothing analysis
* LLM-powered outfit recommendation engine

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/AmmarBinYasir489/AI-powered-outfit-stylist.git
cd AI-powered-outfit-stylist
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file:

```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 4. Start the development server

```bash
npm run dev
```

## Supabase Setup

Create:

* Authentication
* Database tables
* Storage bucket (`wardrobe-images`)
* Edge Functions

  * `analyze-clothing`
  * `generate-outfits`

Deploy the Edge Functions after setting your AI API key as a Supabase secret.

## How It Works

1. User uploads clothing images.
2. AI analyzes each item and extracts metadata automatically.
3. Images are stored in Supabase Storage.
4. Clothing metadata is saved in the database.
5. Users request outfit recommendations.
6. AI ranks compatible outfits based on color harmony, style, season, and occasion.
7. Recommended outfits are displayed on a mannequin with styling explanations.

## Project Structure

```text
src/
 ├── components/
 ├── lib/
 ├── App.tsx
 └── main.tsx

supabase/
 ├── functions/
 └── migrations/
```

## Future Improvements

* Weather-based outfit suggestions
* Occasion-specific recommendations
* Personal style learning
* Virtual try-on with user avatar
* Clothing usage analytics
* Multi-item layering support
* Mobile application

## License

This project is licensed under the MIT License.
