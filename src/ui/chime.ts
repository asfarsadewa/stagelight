/**
 * The two moments the interface makes a sound: accepting a file, and the stage
 * lights coming up. Both play before the music starts, so nothing ever talks
 * over the track. Failures are silent — audio garnish must never block the app.
 */
export class Chime {
  private readonly cache = new Map<string, HTMLAudioElement>();

  private play(name: string, volume: number) {
    try {
      let audio = this.cache.get(name);
      if (!audio) {
        audio = new Audio(`${import.meta.env.BASE_URL}sfx/${name}.mp3`);
        audio.preload = 'auto';
        this.cache.set(name, audio);
      }
      audio.volume = volume;
      audio.currentTime = 0;
      void audio.play().catch(() => {});
    } catch {
      // No sound is an acceptable outcome.
    }
  }

  accept() {
    this.play('accept', 0.35);
  }

  lightsUp() {
    this.play('lights-up', 0.45);
  }
}
