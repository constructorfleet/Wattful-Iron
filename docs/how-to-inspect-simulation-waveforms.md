# Inspect simulation waveforms

Run a configured analog simulation from the **Simulation** view. Each returned voltage or current signal is shown on its own plot, with its net (when available) and unit.

## Measure a signal

Click a point in a plot to place cursor A. Its readout reports the interpolated signal value at that time. Select **B**, then click the plot again to place cursor B. The viewer reports the absolute time difference, signal-value difference, and the frequency represented by that interval. This is a two-point interval measurement; it does not detect periodicity or infer a repeating waveform.

Select **CSV** to download that signal's samples as `time_ms,value_V` or `time_ms,value_A`. The export contains the original simulation samples, regardless of the plot's zoom, pan, cursor, or visibility state.

**Reset** clears both cursors and restores the complete time range.

## Zoom and pan

Use **+** and **−** to zoom around the center of the displayed time range. The left and right arrow buttons pan by one quarter of the current range. They become disabled at the start or end of the simulation. **Reset** restores the full simulation time range.

Use the **Show** checkbox to temporarily hide a signal while comparing the remaining plots. Each plot has its own time range and visibility setting. These controls only change how existing results are displayed; they do not rerun or modify the simulation.

The viewer supports transient time-domain results only. The interval-derived frequency is not an AC analysis or frequency sweep.
