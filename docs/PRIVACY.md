# Privacy policy

*Last updated 14 November 2026.*

Lookplay shows your own game console on a screen in Apple Vision Pro. It works
entirely inside your home network.

## What the app collects

Nothing. The app has no accounts, no analytics, no advertising and no tracking,
and its maker receives no data from it.

## What stays on your headset

- The address of the bridge on your Mac, and the fingerprint of its
  certificate, so the app can find it again and know it is the same one.
- An identifier for the spot where you said your console is. visionOS keeps the
  spot itself; the app never sees or stores pictures or a map of your room.

Deleting the app deletes all of it.

## What travels over your network

The app talks only to the bridge running on your own Mac, over your own Wi-Fi:
video and sound come from it, and your controller's buttons go to it. None of
this goes to the internet or to the app's maker.

## The bridge on your Mac

The bridge is open-source software you run yourself
([source](https://github.com/THEMANINHOLLYWOOD/ps5-vision)). It keeps your
console's pairing key in a file on your Mac and sends nothing anywhere, with one
exception that only happens when you ask for it: if you use **Build for this
game**, the bridge sends a picture of the game on screen, or the game's name you
typed, to Anthropic through the Claude account already signed in on your Mac, to
get a keyboard layout back. Anthropic's own privacy policy covers that request.

## Permissions the app asks for

- **Local network:** to find the bridge on your Mac.
- **World sensing:** to remember where your console is in the room.

## Questions

Open an issue at <https://github.com/THEMANINHOLLYWOOD/ps5-vision/issues>.
