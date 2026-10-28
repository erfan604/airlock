// sample gate for the evidence tests
pub struct Gate;

impl Gate {
    pub fn allows(&self, recipient: &str) -> bool {
        !recipient.is_empty()
    }
}

// end of the sample gate
