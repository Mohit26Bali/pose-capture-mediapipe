"""
One-off helper: downloads a small set of sample photos from Pexels to use as
test fixtures for the pose-capture backend (people in various poses, plus a
couple of person-less scenes for the "no pose detected" case).

Needs a free Pexels API key in the PEXELS_API_KEY environment variable
(https://www.pexels.com/api/). The key is never written to this repo.
Usage:
    python fetch_sample_pose_images.py
"""

import os
import time
import requests

HOTEL_SCRIPT_PATH = r"D:\images\fetch_hotel_images_pexels.py"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "pexels")
BASE_URL = "https://api.pexels.com/v1/search"

# (keyword, count, expect_pose) - expect_pose is just for the printed summary
KEYWORDS = [
    ("man standing full body portrait", 3, True),
    ("woman doing yoga pose", 3, True),
    ("athlete running full body", 3, True),
    ("person walking street full body", 3, True),
    ("group of friends standing full body outdoors", 3, True),
    ("family standing together full body", 3, True),
    ("empty room interior", 2, False),
    ("mountain landscape", 2, False),
]


def load_api_key() -> str:
    key = os.environ.get("PEXELS_API_KEY")
    if not key:
        raise SystemExit("Set the PEXELS_API_KEY environment variable first (free key: https://www.pexels.com/api/).")
    return key


def sanitize(name: str) -> str:
    return name.replace(" ", "_").lower()


def fetch_keyword(keyword: str, count: int, session: requests.Session, api_key: str):
    downloaded = []
    resp = session.get(
        BASE_URL,
        params={"query": keyword, "per_page": count, "page": 1},
        headers={"Authorization": api_key},
    )
    if resp.status_code == 401:
        print("Invalid API key.")
        return downloaded
    if resp.status_code == 429:
        print("Rate limit hit.")
        return downloaded
    resp.raise_for_status()
    photos = resp.json().get("photos", [])

    for photo in photos[:count]:
        img_url = photo["src"]["large"]
        filename = f"{sanitize(keyword)}_{photo['id']}.jpg"
        filepath = os.path.join(OUTPUT_DIR, filename)
        img_resp = session.get(img_url)
        img_resp.raise_for_status()
        with open(filepath, "wb") as f:
            f.write(img_resp.content)
        downloaded.append(filepath)
        print(f"  saved {filename}")
        time.sleep(0.3)

    return downloaded


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    api_key = load_api_key()
    session = requests.Session()

    for keyword, count, expect_pose in KEYWORDS:
        print(f"Fetching '{keyword}' ({count}, expect_pose={expect_pose})...")
        fetch_keyword(keyword, count, session, api_key)

    print(f"\nDone. Images saved to {os.path.abspath(OUTPUT_DIR)}")


if __name__ == "__main__":
    main()
