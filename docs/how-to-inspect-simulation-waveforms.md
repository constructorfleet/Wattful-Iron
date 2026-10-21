# Inspect simulation waveforms

Run a configured analog simulation from the **Simulation** view. Each returned voltage or current signal is shown on its own plot, with its net (when available) and unit.

## Measure a signal

Click a point in a plot to place cursor A. Its readout reports the interpolated signal value at that time. Select **B**, then click the plot again to place cursor B. The viewer reports the absolute time difference, signal-value difference, and the frequency represented by that interval. This is a two-point interval measurement; it does not detect periodicity or infer a repeating waveform.

Select **CSV** to download that signal's samples as `time_ms,value_V` or `time_ms,value_A`. The export contains the original simulation samples, regardless of the plot's zoom, pan, cursor, or visibility state.

**Reset** clears both cursors and restores the complete time range.

## Zoom and pan

Use **+** and **−** to zoom around the center of the displayed time range. The left and right arrow buttons pan by one quarter of the current range. They become disabled at the start or end of the simulation. **Reset** restores the full simulation time range.

Use the **Show** checkbox to temporarily hide a signal while comparing the remaining plots. Each plot has its own time range and visibility setting. These controls only change how existing results are displayed; they do not rerun or modify the simulation.

## Read a DC operating point

When the build contains a DC operating point experiment, the panel lists each node voltage and branch current above the plots, with the net each probe references. Those same values drive the **Power** section below the plots: supply current, component dissipation (I²R or V²/R, labelled per component), and each measured current against the IPC-2221 capacity of the copper carrying its net. A current above that capacity is flagged **over capacity**.

## Read DC and AC sweeps

DC sweeps are plotted with the swept source value on the x axis instead of time. AC sweeps are plotted twice: magnitude in dB and phase in degrees, both against frequency in hertz. The cursor readout follows the plotted x unit, and the interval-derived frequency is reported only for time-domain plots.

## What is not evaluated

The panel ends with the analyses that produced no results in this build, and the modes the workbench cannot report at all: temperature sweeps, Monte Carlo tolerance analysis, and digital or mixed-signal simulation. Regulator loading, resistor power-rating headroom, and thermal rise are never evaluated, because Circuit JSON carries no regulator model or power ratings and no thermal analysis is performed.

All results come from the tscircuit SPICE run in that build, at its configured source values only. The interval-derived frequency on a transient plot is not an AC analysis.
