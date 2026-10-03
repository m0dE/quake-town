// qtrun: run a Quake Town world natively and print what happens.
//   cargo run --release --bin qtrun -- --progs qwprogs.dat --map lqdm1.bsp [--map lqdm2.bsp …]
//        --ticks 7700 --info '\mode\ffa\deathmatch\3\maxclients\8\bots\1'
//        [--seed 1] [--human N] [--cmd TICK:SLOT:text] [--dprint] [--ents] [--hash]
// Prints every print / centerprint / obituary / stufftext / changelevel / matchstate /
// pickup event with its tick, dprint output with --dprint, and the error if the world stops.
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.

use std::sync::Arc;

use qtsim::bsp::Map;
use qtsim::events::*;
use qtsim::World;

fn usage() -> ! {
    eprintln!(
        "usage: qtrun --progs FILE --map FILE.bsp [--map …] [--ticks N] [--info INFOSTRING] [--seed N]\n\
         \x20            [--human N] [--cmd TICK:SLOT:TEXT] [--dprint] [--ents] [--hash] [--quiet]"
    );
    std::process::exit(2)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut progs_path = None;
    let mut map_paths = Vec::new();
    let mut ticks = 77 * 60u32;
    let mut info = String::from("\\deathmatch\\1\\maxclients\\8\\bots\\1");
    let mut seed = 1u32;
    let mut humans = 0usize;
    let mut cmds: Vec<(u32, usize, String)> = Vec::new();
    let mut dprint = false;
    let mut ents = false;
    let mut hash = false;
    let mut quiet = false;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let mut val = || {
            i += 1;
            args.get(i).cloned().unwrap_or_else(|| usage())
        };
        match a {
            "--progs" => progs_path = Some(val()),
            "--map" => map_paths.push(val()),
            "--ticks" => ticks = val().parse().unwrap_or_else(|_| usage()),
            "--info" => info = val(),
            "--seed" => seed = val().parse().unwrap_or_else(|_| usage()),
            "--human" => humans = val().parse().unwrap_or_else(|_| usage()),
            "--cmd" => {
                let v = val();
                let mut p = v.splitn(3, ':');
                let t = p.next().and_then(|x| x.parse().ok()).unwrap_or_else(|| usage());
                let s = p.next().and_then(|x| x.parse().ok()).unwrap_or_else(|| usage());
                cmds.push((t, s, p.next().unwrap_or("").to_string()));
            }
            "--dprint" => dprint = true,
            "--ents" => ents = true,
            "--hash" => hash = true,
            "--quiet" => quiet = true,
            "-h" | "--help" => usage(),
            _ => usage(),
        }
        i += 1;
    }
    let progs_path = progs_path.unwrap_or_else(|| usage());
    if map_paths.is_empty() {
        usage();
    }
    let pbytes = std::fs::read(&progs_path).unwrap_or_else(|e| {
        eprintln!("{progs_path}: {e}");
        std::process::exit(1)
    });
    let progs = qtsim::qcvm::Progs::load(&pbytes).unwrap_or_else(|e| {
        eprintln!("progs_load: {e} (code {})", e.code());
        std::process::exit(1)
    });
    let mut maps = Vec::new();
    for p in &map_paths {
        let b = std::fs::read(p).unwrap_or_else(|e| {
            eprintln!("{p}: {e}");
            std::process::exit(1)
        });
        let name = std::path::Path::new(p).file_stem().unwrap().to_string_lossy().to_string();
        let m = Map::load(&name, &b).unwrap_or_else(|e| {
            eprintln!("{p}: {e}");
            std::process::exit(1)
        });
        maps.push(Arc::new(m));
    }
    let t0 = std::time::Instant::now();
    let mut w = match World::new(progs, maps, 0, seed, info.as_bytes()) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("world_new: {e}");
            std::process::exit(1)
        }
    };
    w.set_log(true);
    println!(
        "qtrun: map {} maxclients {} bots {} edicts {} models {} sounds {} (spawn {:.1} ms)",
        w.sv.map.name,
        w.sv.maxclients,
        w.sv.bots_enabled,
        w.vm.num_edicts(),
        w.sv.model_precache.len(),
        w.sv.sound_precache.len(),
        t0.elapsed().as_secs_f64() * 1000.0
    );
    flush_log(&mut w, dprint);
    let mut lines = Lines { buf: Default::default() };
    for h in 0..humans {
        let slot = w.free_slot();
        if slot < 0 {
            break;
        }
        let ui = format!("\\name\\human{h}\\topcolor\\4\\bottomcolor\\12\\team\\red");
        w.client_join(slot as usize, ui.as_bytes());
        print_events(&w, 0, quiet, &mut lines);
    }
    let mut ticks_run = 0;
    let t1 = std::time::Instant::now();
    for t in 1..=ticks {
        for (ct, slot, text) in &cmds {
            if *ct == t {
                w.client_command(*slot, text.as_bytes());
            }
        }
        w.tick();
        ticks_run = t;
        print_events(&w, t, quiet, &mut lines);
        flush_log(&mut w, dprint);
        if hash && t % 770 == 0 {
            println!("[{t}] hash {:08x}", w.hash());
        }
        if let Some(e) = &w.sv.error {
            println!("[{t}] WORLD STOPPED: {e}");
            break;
        }
    }
    let el = t1.elapsed().as_secs_f64();
    println!(
        "qtrun: {} ticks ({:.1} s game time) in {:.2} s, {:.1} µs/tick; hash {:08x}",
        ticks_run,
        ticks_run as f64 * 0.013,
        el,
        el * 1e6 / ticks_run.max(1) as f64,
        w.hash()
    );
    let mut rows = Vec::new();
    w.view_clients(&mut rows);
    for s in 0..w.sv.maxclients {
        let c = &w.sv.clients[s];
        if c.state != 0 {
            println!("  slot {s:2} {:>12} state {} frags {}", String::from_utf8_lossy(&c.name), c.state, rows[1 + s * 32 + 3] as i32);
        }
    }
    if ents {
        let mut v = Vec::new();
        w.view_ents(&mut v);
        println!("entities: {}", v[0]);
        let names = &w.sv.model_precache;
        for k in 0..v[0] as usize {
            let e = &v[1 + k * 20..1 + (k + 1) * 20];
            let mi = e[2] as usize;
            println!(
                "  #{:<5} model {:3} {:<28} frame {:3} at ({:.1} {:.1} {:.1})",
                e[0],
                mi,
                names.get(mi).map(|n| String::from_utf8_lossy(n).to_string()).unwrap_or_default(),
                e[3],
                f32::from_bits(e[8]),
                f32::from_bits(e[9]),
                f32::from_bits(e[10])
            );
        }
    }
    if w.sv.error.is_some() {
        std::process::exit(3);
    }
}

fn flush_log(w: &mut World, dprint: bool) {
    if !w.sv.log.is_empty() {
        if dprint {
            print!("{}", String::from_utf8_lossy(&w.sv.log));
        }
        w.sv.log.clear();
    }
}

/// prints arrive in pieces (one bprint per QC call, as QW sends them); join them
/// into lines per target
struct Lines {
    buf: std::collections::BTreeMap<i32, String>,
}

impl Lines {
    fn add(&mut self, tick: u32, to: i32, text: &str, quiet: bool) {
        let b = self.buf.entry(to).or_default();
        b.push_str(text);
        while let Some(n) = b.find('\n') {
            let line: String = b.drain(..=n).collect();
            if !quiet || to < 0 {
                let who = if to < 0 { "all".to_string() } else { format!("{to}") };
                println!("[{tick}] print({who}) {}", line.trim_end_matches('\n'));
            }
        }
    }
}

fn print_events(w: &World, tick: u32, quiet: bool, lines: &mut Lines) {
    let s = |i: u32| -> String {
        w.sv.sink.strings.get(i as usize).map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default()
    };
    let who = |slot: i32| -> String {
        if slot < 0 {
            "all".into()
        } else {
            format!("{slot}")
        }
    };
    for e in &w.sv.sink.events {
        let a = e.w[1] as i32;
        match e.kind() {
            EV_PRINT => lines.add(tick, a, &s(e.w[3]), quiet),
            EV_CENTERPRINT => println!("[{tick}] centerprint({}) {}", who(a), s(e.w[2]).replace('\n', "\\n")),
            EV_STUFFTEXT => {
                if !quiet {
                    println!("[{tick}] stufftext({}) {}", who(a), s(e.w[2]).replace('\n', "\\n"))
                }
            }
            EV_OBITUARY => println!(
                "[{tick}] obituary victim {} killer {} deathtype {} flags {}",
                a, e.w[2] as i32, e.w[3] as i32, e.w[4] as i32
            ),
            EV_MATCHSTATE => println!(
                "[{tick}] matchstate phase {} score {}:{} round {} end {:.1} countdown {:.1}",
                a,
                e.w[2] as i32,
                e.w[3] as i32,
                e.w[4] as i32,
                f32::from_bits(e.w[8]),
                f32::from_bits(e.w[9])
            ),
            EV_CHANGELEVEL => println!("[{tick}] changelevel -> map {} ({})", a, w.sv.map.name),
            EV_PICKUP => {
                if !quiet {
                    println!("[{tick}] pickup slot {} item {}", a, e.w[2] as i32)
                }
            }
            EV_INTERMISSION => println!("[{tick}] intermission"),
            _ => {}
        }
    }
}
