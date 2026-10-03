use qtsim::bsp::*;

pub fn lq_dir() -> String {
    "/app/data/home/quake-ref/full/id1/maps".to_string()
}

#[test]
fn all_lqdm_maps_load() {
    for i in 1..=13 {
        let path = format!("{}/lqdm{}.bsp", lq_dir(), i);
        let bytes = std::fs::read(&path).expect("read map");
        let m = Map::load(&format!("lqdm{i}"), &bytes).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert!(m.models.len() >= 1);
        assert!(m.entities_text().contains("worldspawn"));
        // a point inside the world bounds should resolve to some leaf
        let w = &m.models[0];
        let c = [(w.mins[0] + w.maxs[0]) * 0.5, (w.mins[1] + w.maxs[1]) * 0.5, (w.mins[2] + w.maxs[2]) * 0.5];
        let leaf = m.point_in_leaf(&c);
        assert!(leaf < m.leafs.len());
        let mut pvs = Vec::new();
        m.leaf_pvs(leaf, &mut pvs);
        assert_eq!(pvs.len(), (m.numleafs + 7) >> 3);
        println!(
            "lqdm{i}: bsp2={} planes={} nodes={} leafs={} (vis {}) clipnodes={} models={} ents={}B vis={}B",
            m.bsp2,
            m.planes.len(),
            m.nodes.len(),
            m.leafs.len(),
            m.numleafs,
            m.clipnodes.len(),
            m.models.len(),
            m.entities.len(),
            m.visdata.len()
        );
    }
}

#[test]
fn rejects_garbage() {
    assert!(Map::load("x", &[0u8; 10]).is_err());
    let mut b = vec![0u8; 200];
    b[0] = 30;
    assert!(Map::load("x", &b).is_err());
    b[0..4].copy_from_slice(b"2PSB");
    assert_eq!(Map::load("x", &b).unwrap_err(), BspError::Bsp2Rev);
}
