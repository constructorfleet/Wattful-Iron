# Inspect simulation waveforms

Run a configured analog simulation from the **Simulation** view. Each returned voltage or current signal is shown on its own plot, with its net (when available) and unit.

## Measure a signal

Click a point in a plot to place its measurement cursor. The readout reports the interpolated signal value at that time. Click another point to move the cursor. **Reset** clears the cursor and restores the complete time range.

## Zoom and pan

Use **+** and **−** to zoom around the center of the displayed time range. The left and right arrow buttons pan by one quarter of the current range. They become disabled at the start or end of the simulation. **Reset** restores the full simulation time range.

Use the **Show** checkbox to temporarily hide a signal while comparing the remaining plots. Each plot has its own time range and visibility setting. These controls only change how existing results are displayed; they do not rerun or modify the simulation.

The current viewer supports transient time-domain measurements. Frequency measurements, linked cursors across signals, and exporting samples are not yet available.
